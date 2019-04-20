import 'babel-polyfill';
import * as tf from '@tensorflow/tfjs'
import * as nsfwjs from './nsfw_wrapper.js';

var browser = chrome || browser;

const MODEL_PATH = browser.extension.getURL('model/');
const IMG_MIN_WIDTH = 32;
const IMG_MIN_HEIGHT = 32;

class NSFW_Processing {

	constructor() {
		this.useWorkers = false;
		this.model = null;
		this.cache = new Cache();

		// Listen for images
		this.addListeners();

		// If use workers
		if (this.useWorkers) {
			// Load workers
			browser.system.cpu.getInfo((info) => {
				this.loadWorkers(info.numOfProcessors);
			});
		}
		// Use this thread
		else {
			this.loadModel();
		}
		
	}

	loadWorkers(num) {
		this.workers_ready = false;
		this.jobs = [];
		this.workers = [];
		console.log('Loading ' + num + ' workers...');
		let wait2load = num;
		for (let i = 1; i <= num; i++) {
			let worker = {};
			worker.id = i;
			worker.ready = false;
			worker.busy = false;
			worker.worker = new Worker(browser.extension.getURL('src/worker.js'));
			worker.worker.onmessage = (e) => {
				if (!e.data || !e.data.action) return;
				switch(e.data.action) {

					case 'initialized':
						console.log('Worker ' + worker.id + ' loaded.');
						worker.ready = true;
						wait2load--;
						if (wait2load <= 0) {
							console.log('All workers are ready.');
							this.workers_ready = true;
						}
						break;

					case 'result':
						worker.busy = false;
						console.log('Result from worker ' + worker.id + '.', e.data);
						this.analyzeImageResult(e.data.data.id, e.data.data.predictions);
						break;

					case 'debug':
						console.log('Debug worker ' + worker.id, e.data);
						break;

				}
				this.handleJobs();
			}
			worker.worker.postMessage({action : 'init', data : MODEL_PATH});
			this.workers.push(worker);
		}
	}

	loadModel() {
		this.model_ready = false;
		this.jobs = [];
		this.here_busy = false;
		this.model = null;
		console.log('Loading model...');

		// Load model
		nsfwjs.load(MODEL_PATH).then((model) => {
			this.model = model;
			this.model_ready = true;
			console.log('Model loaded.');
			this.handleJobs();
		});
	}

	addListeners() {
		// Listen for images requests
		browser.webRequest.onCompleted.addListener(req => {
			if (req && req.tabId > 0) {
				this.handleImage(req.url, req.tabId);
			}
		}, {urls: ["<all_urls>"], types: ["image"]});

		// Listen for content script requests
		browser.runtime.onMessage.addListener((message, sender) => {
			if (message && message.action === 'NSFW-IMAGE-FOR-ANALYSIS') {
				this.handleImage(message.payload.url, sender.tab.id);
			}
		});

		// Listen tab close
		browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
			var data = this.cache.all();
			for (let id in data) {
				if (data.hasOwnProperty(id)) {
					let index = data[id].tabs.indexOf(tabId);
					if (index > -1) data[id].tabs.splice(index, 1);
				}
			}
		});
	}

	handleImage(url, tabId) {
		// Ignore if exists
		let meta = this.cache.get(url);
		if (meta && meta.tabs) {
			// If results
			if (meta.analyzed) {
				this.reportImageAnalysis(tabId, meta);
				return;
			}
			// If tab is not on the list
			if (meta.tabs.indexOf(tabId) == -1) {
				meta.tabs.push(tabId);
			}
			// If analysis is not running
			if (!meta.analyzing) {
				this.analyzeImage(meta);
			}
			return;
		}

		// Save info
		meta = {
			tabs : [tabId],
			url : url,
			analyzing : false,
			analyzed : false,
			predictions : null
		};
		this.cache.set(meta.url, meta);
		this.analyzeImage(meta);
	}

	async analyzeImage(meta) {
		// Load image
		const img = await this.loadImage(meta.url);
		if (!img) return;

		// Analyze image
		meta.analyzing = true;
		//meta.predictions = await this.predict(img);


		if (this.useWorkers) {
			let tensor = tf.browser.fromPixels(img);
			tensor.data().then((data) => {
				this.jobs.push({
					id : meta.url,
					img : {
						data : data,
						shape : tensor.shape,
						dtype : tensor.dtype
					}
				});
				this.handleJobs();
			});
		}
		else {
			this.jobs.push({
				id : meta.url,
				img : img
			});
			this.handleJobs();
		}

	}

	handleJobs() {
		if (this.useWorkers) {
			return this.handleJobs_Workers();
		}
		else {
			return this.handleJobs_Here();
		}
	}

	handleJobs_Workers() {
		if (!this.workers_ready) return false;
		// If no jobs exit
		if (this.jobs.length == 0) return false;
		// Find worker
		for (let i = 0; i < this.workers.length; i++) {
			if (!this.workers[i].busy) {
				this.workers[i].busy = true;
				this.workers[i].worker.postMessage({action : 'job', data : this.jobs.shift()});
				return true;
			}
		}
		return false;
	}

	handleJobs_Here() {
		if (!this.model_ready) return false;
		// If no jobs exit
		if (this.jobs.length == 0) return false;
		// Return if busy
		if (this.here_busy) return false;
		this.here_busy = true;

		let job = this.jobs.shift();
		this.model.classify(job.img).then((predictions) => {
			this.here_busy = false;
			this.analyzeImageResult(job.id, predictions);
			this.handleJobs();
		});

		return true;
	}

	analyzeImageResult(url, predictions) {
		var meta = this.cache.get(url);
		if (!meta) {
			meta = this.cache.set(url, {
				tabs : [],
				url : url,
				analyzing : true,
				analyzed : false,
				predictions : null
			});
		}

		if (!predictions) return;
		meta.predictions = predictions;
		meta.analyzing = false;
		meta.analyzed = true;

		//console.log(JSON.parse(JSON.stringify(meta)));

		// Report analysis
		var tabs = meta.tabs;
		meta.tabs = [];
		for (let i = tabs.length - 1; i >= 0; i--) {
			this.reportImageAnalysis(tabs[i], meta);
		}
	}

	reportImageAnalysis(tab, meta) {
		//console.log('reportImageAnalysis', tab, meta);
		// Send to tab
		browser.tabs.sendMessage(tab, {
			action: 'NSFW-IMAGE-ANALYSIS-REPORT',
			payload: meta,
		});
	}

	async loadImage(src) {
		return new Promise(resolve => {
			var img = document.createElement('img');
			img.crossOrigin = "anonymous";
			img.onerror = function(e) {
				resolve(null);
			};
			img.onload = function(e) {
				if ((img.height && img.height > IMG_MIN_HEIGHT) || (img.width && img.width > IMG_MIN_WIDTH)) {
					resolve(img);
				}
				// Let's skip all tiny images
				resolve(null);
			}
			img.src = src;
		});
	}
}

class Cache {
	constructor() {
		this.table = {};

		const timeout = 5 * 60 * 1000;
		setInterval(() => {
			this.clean(timeout);
		}, timeout);
	}

	get(id) {
		if (!this.table.hasOwnProperty(id)) {
			return null;
		}
		this.table[id].timestamp = new Date().getTime();
		return this.table[id].data;
	}

	all() {
		var table = {};
		for (let id in this.table) {
			if (this.table.hasOwnProperty(id)) {
				table[id] = this.table[id].data;
			}
		}
		return table;
	}

	set(id, data) {
		this.table[id] = {
			id : id,
			data : data,
			timestamp : new Date().getTime()
		};
		return this.table[id].data;
	}

	clean(timeout) {
		const threshold = new Date().getTime() - timeout;
		for (let id in this.table) {
			if (this.table.hasOwnProperty(id) && this.table[id].timestamp < threshold) {
				delete this.table[id];
			}
		}
	}
}

var bg = new NSFW_Processing();

//bg.handleImage('data:image/png;base64,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', -1);
