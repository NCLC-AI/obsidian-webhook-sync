import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, EventRef } from 'obsidian';

interface WebhookSyncSettings {
	webhookUrl: string;
	syncInterval: number;
	autoSyncOnStartup: boolean;
	enableDebugLogging: boolean;
	outboundWebhookUrl: string;
	enableRealTimeSync: boolean;
	debounceDelayMs: number;
	batchSize: number;
	initialSyncBatchSize: number;
	forceInboundWebhookUrl: string; // 새로운 Force Inbound URL
	autoForceInboundOnStartup: boolean; // 시작시 Force Inbound 실행 여부
}

const DEFAULT_SETTINGS: WebhookSyncSettings = {
	webhookUrl: '',
	syncInterval: 1,
	autoSyncOnStartup: true,
	enableDebugLogging: true,
	outboundWebhookUrl: '',
	enableRealTimeSync: false,
	debounceDelayMs: 3000,
	batchSize: 10,
	initialSyncBatchSize: 5,
	forceInboundWebhookUrl: '', // 새로운 기본값
	autoForceInboundOnStartup: false // 새로운 기본값
}

interface ChangeEvent {
	type: 'create' | 'modify' | 'delete' | 'rename';
	filePath: string;
	oldPath?: string;
	timestamp: string;
	file?: TFile;
	ctime?: number;
	mtime?: number;
	size?: number;
}

interface InitialSyncProgress {
	total: number;
	processed: number;
	current: string;
	errors: string[];
	isRunning: boolean;
}

/**
 * Modal for showing initial sync progress
 */
class InitialSyncModal extends Modal {
	private progress: InitialSyncProgress;
	private progressEl: HTMLElement;
	private statusEl: HTMLElement;
	private progressBarEl: HTMLElement;
	private currentFileEl: HTMLElement;
	private errorsEl: HTMLElement;
	private cancelButton: HTMLButtonElement;
	private cancelled = false;

	constructor(app: App, private onCancel: () => void) {
		super(app);
		this.progress = {
			total: 0,
			processed: 0,
			current: '',
			errors: [],
			isRunning: false
		};
	}

	onOpen() {
		const { contentEl } = this;
		
		contentEl.createEl('h2', { text: '🔄 Initial Sync in Progress' });
		contentEl.createEl('p', { text: 'Syncing all existing notes to your webhook endpoint...' });
		
		// Progress bar
		this.progressEl = contentEl.createDiv('sync-progress');
		this.statusEl = this.progressEl.createEl('div', { cls: 'sync-status' });
		
		const progressContainer = this.progressEl.createDiv('progress-container');
		this.progressBarEl = progressContainer.createDiv('progress-bar');
		
		this.currentFileEl = this.progressEl.createEl('div', { cls: 'current-file' });
		
		// Errors section
		this.errorsEl = contentEl.createDiv('sync-errors');
		
		// Cancel button
		const buttonContainer = contentEl.createDiv('button-container');
		this.cancelButton = buttonContainer.createEl('button', { 
			text: 'Cancel',
			cls: 'mod-warning'
		});
		this.cancelButton.onclick = () => {
			this.cancelled = true;
			this.onCancel();
			this.close();
		};
		
		// Add CSS
		this.addProgressStyles();
	}
	
	private addProgressStyles() {
		const style = document.createElement('style');
		style.textContent = `
			.sync-progress {
				margin: 20px 0;
			}
			.sync-status {
				margin-bottom: 10px;
				font-weight: bold;
			}
			.progress-container {
				width: 100%;
				height: 20px;
				background-color: var(--background-modifier-border);
				border-radius: 10px;
				overflow: hidden;
				margin-bottom: 10px;
			}
			.progress-bar {
				height: 100%;
				background-color: var(--interactive-accent);
				width: 0%;
				transition: width 0.3s ease;
			}
			.current-file {
				font-size: 0.9em;
				color: var(--text-muted);
				margin-bottom: 10px;
			}
			.sync-errors {
				max-height: 150px;
				overflow-y: auto;
				margin-top: 15px;
			}
			.error-item {
				color: var(--text-error);
				font-size: 0.8em;
				margin-bottom: 5px;
			}
			.button-container {
				text-align: center;
				margin-top: 20px;
			}
		`;
		document.head.appendChild(style);
	}

	updateProgress(progress: InitialSyncProgress) {
		this.progress = progress;
		
		// Update status
		const percentage = this.progress.total > 0 ? Math.round((this.progress.processed / this.progress.total) * 100) : 0;
		this.statusEl.textContent = `Progress: ${this.progress.processed}/${this.progress.total} (${percentage}%)`;
		
		// Update progress bar
		this.progressBarEl.style.width = `${percentage}%`;
		
		// Update current file
		this.currentFileEl.textContent = this.progress.current ? `Processing: ${this.progress.current}` : '';
		
		// Update errors
		this.errorsEl.empty();
		if (this.progress.errors.length > 0) {
			const errorTitle = this.errorsEl.createEl('h4', { text: 'Errors:' });
			this.progress.errors.forEach(error => {
				this.errorsEl.createEl('div', { 
					text: error,
					cls: 'error-item'
				});
			});
		}
		
		// Update cancel button
		if (!this.progress.isRunning) {
			this.cancelButton.textContent = 'Close';
			this.cancelButton.className = 'mod-cta';
		}
	}
	
	isCancelled(): boolean {
		return this.cancelled;
	}
}

/**
 * Queue manager for handling file changes with debouncing and batching
 */
class ChangeQueue {
	private queue: ChangeEvent[] = [];
	private processing = false;
	private debounceTimer: number | null = null;
	private maxQueueSize = 1000;
	
	constructor(private plugin: WebhookSyncPlugin) {}
	
	async addChange(event: ChangeEvent): Promise {
		// Get file stats if file exists
		if (event.file) {
			event.ctime = event.file.stat.ctime;
			event.mtime = event.file.stat.mtime;
			event.size = event.file.stat.size;
		}
		
		// Prevent queue overflow
		if (this.queue.length >= this.maxQueueSize) {
			this.plugin.log(`Queue overflow, dropping oldest events`);
			this.queue.splice(0, Math.floor(this.maxQueueSize / 2));
		}
		
		// Remove duplicates for same file path and type (keep latest)
		this.queue = this.queue.filter(e => 
			!(e.filePath === event.filePath && e.type === event.type)
		);
		
		this.queue.push(event);
		
		this.plugin.log(`Change queued: ${event.type} - ${event.filePath}`, {
			oldPath: event.oldPath || 'none',
			queueSize: this.queue.length
		});
		
		this.scheduleProcessing();
	}
	
	private scheduleProcessing() {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		
		this.debounceTimer = window.setTimeout(() => {
			this.processQueue();
		}, this.plugin.settings.debounceDelayMs);
	}
	
	private async processQueue() {
		if (this.processing || this.queue.length === 0) {
			return;
		}
		
		if (!this.plugin.settings.outboundWebhookUrl) {
			this.plugin.log('Outbound webhook URL not configured, clearing queue');
			this.queue = [];
			return;
		}
		
		this.processing = true;
		
		try {
			while (this.queue.length > 0) {
				const batch = this.queue.splice(0, this.plugin.settings.batchSize);
				await this.processBatch(batch);
				
				// Prevent overwhelming the webhook
				if (this.queue.length > 0) {
					await this.delay(500);
				}
			}
		} catch (error) {
			this.plugin.log('Queue processing error:', error);
		} finally {
			this.processing = false;
		}
	}
	
	private async processBatch(batch: ChangeEvent[]) {
		this.plugin.log(`Processing batch of ${batch.length} changes`);
		
		const payload = {
			timestamp: new Date().toISOString(),
			changes: await this.prepareBatchData(batch)
		};
		
		try {
			const response = await fetch(this.plugin.settings.outboundWebhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'Obsidian-WebhookSync/1.0'
				},
				body: JSON.stringify(payload)
			});
			
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			
			this.plugin.log(`Batch sent successfully: ${batch.length} changes`);
			
		} catch (error) {
			this.plugin.log(`Failed to send batch:`, error);
		}
	}
	
	private async prepareBatchData(batch: ChangeEvent[]) {
		const changes = [];
		
		for (const event of batch) {
			const changeData: any = {
				type: event.type,
				filePath: event.filePath,
				timestamp: event.timestamp,
				ctime: event.ctime,
				mtime: event.mtime,
				size: event.size
			};
			
			// Add oldPath for rename and delete events
			if (event.type === 'rename' || event.type === 'delete') {
				changeData.oldPath = event.oldPath || '';
			}
			
			// Add content for create/modify/rename events
			if ((event.type === 'create' || event.type === 'modify' || event.type === 'rename') && event.file) {
				try {
					changeData.content = await this.plugin.app.vault.read(event.file);
					changeData.fileName = event.file.name;
					changeData.folder = event.file.parent?.path || '';
				} catch (error) {
					this.plugin.log(`Failed to read file: ${event.filePath}`, error);
					changeData.content = null;
					changeData.error = 'Failed to read file content';
				}
			}
			
			changes.push(changeData);
		}
		
		return changes;
	}
	
	private delay(ms: number): Promise {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
	
	/**
	 * Process initial sync batch - separate from regular queue
	 */
	async processInitialSyncBatch(files: TFile[]): Promise<{ success: number; errors: string[] }> {
		const batch: ChangeEvent[] = files.map(file => ({
			type: 'create' as const, // Initial sync treats all as create
			filePath: file.path,
			timestamp: new Date().toISOString(),
			file: file,
			ctime: file.stat.ctime,
			mtime: file.stat.mtime,
			size: file.stat.size
		}));
		
		const changes = await this.prepareBatchData(batch);
		const payload = {
			timestamp: new Date().toISOString(),
			isInitialSync: true,
			changes: changes
		};
		
		try {
			const response = await fetch(this.plugin.settings.outboundWebhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'Obsidian-WebhookSync/1.0'
				},
				body: JSON.stringify(payload)
			});
			
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			
			return { success: files.length, errors: [] };
			
		} catch (error) {
			const errorMsg = `Failed to sync batch: ${error.message}`;
			return { 
				success: 0, 
				errors: files.map(f => `${f.path}: ${errorMsg}`) 
			};
		}
	}
	
	destroy() {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.queue = [];
		this.processing = false;
	}
}

export default class WebhookSyncPlugin extends Plugin {
	settings: WebhookSyncSettings;
	syncIntervalId: number | null = null;
	private changeQueue: ChangeQueue | null = null;
	private vaultEventRefs: EventRef[] = [];
	private initialSyncModal: InitialSyncModal | null = null;
	private initialSyncCancelled = false;

	async onload() {
		await this.loadSettings();
		
		// Initialize change queue
		this.changeQueue = new ChangeQueue(this);

		// Add ribbon icon
		this.addRibbonIcon('sync', 'Sync from webhook', () => {
			this.syncFromWebhook();
		});

		// Commands
		this.addCommand({
			id: 'sync-from-webhook',
			name: 'Sync documents from webhook',
			callback: () => {
				this.syncFromWebhook();
			}
		});
		
		this.addCommand({
			id: 'toggle-realtime-sync',
			name: 'Toggle real-time sync',
			callback: () => {
				this.toggleRealtimeSync();
			}
		});
		
		this.addCommand({
			id: 'initial-sync-all-notes',
			name: 'Initial Sync: Send all notes to webhook',
			callback: () => {
				this.startInitialSync();
			}
		});

		// 새로운 Force Inbound 명령어 추가
		this.addCommand({
			id: 'force-inbound-sync',
			name: 'Force Inbound Sync: Get documents from webhook',
			callback: () => {
				this.forceInboundSync();
			}
		});

		this.addSettingTab(new WebhookSyncSettingTab(this.app, this));

		// Setup real-time sync if enabled
		if (this.settings.enableRealTimeSync) {
			this.setupRealtimeSync();
		}

		// Auto-sync on startup
		if (this.settings.autoSyncOnStartup) {
			setTimeout(() => {
				this.syncFromWebhook();
			}, 2000);
		}

		// Auto Force Inbound sync on startup
		if (this.settings.autoForceInboundOnStartup) {
			setTimeout(() => {
				this.forceInboundSync();
			}, 3000);
		}

		this.startPeriodicSync();
		console.log('🔄 Webhook Sync plugin loaded');
	}

	onunload() {
		this.stopPeriodicSync();
		this.stopRealtimeSync();
		
		// Clean up change queue
		if (this.changeQueue) {
			this.changeQueue.destroy();
			this.changeQueue = null;
		}
		
		// Close initial sync modal if open
		if (this.initialSyncModal) {
			this.initialSyncModal.close();
		}
		
		console.log('🔄 Webhook Sync plugin unloaded');
	}

	log(message: string, data?: any) {
		if (this.settings?.enableDebugLogging) {
			if (data) {
				console.log(`[WebhookSync] ${message}`, data);
			} else {
				console.log(`[WebhookSync] ${message}`);
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.startPeriodicSync();
		
		// Update real-time sync based on settings
		if (this.settings.enableRealTimeSync) {
			this.setupRealtimeSync();
		} else {
			this.stopRealtimeSync();
		}
	}

	/**
	 * NEW: Force Inbound Sync - 강제로 webhook에서 문서들을 가져와 동기화
	 */
	async forceInboundSync() {
		if (!this.settings.forceInboundWebhookUrl) {
			new Notice('❌ Force Inbound Webhook URL is not configured. Please set it in settings.');
			return;
		}

		this.log('=== Starting Force Inbound Sync ===', { url: this.settings.forceInboundWebhookUrl });
		new Notice('⚡ Force syncing documents from webhook...');

		try {
			this.log('Sending HTTP request for force inbound...');
			const response = await fetch(this.settings.forceInboundWebhookUrl);
			
			this.log('Force inbound response received', {
				status: response.status,
				ok: response.ok,
				contentType: response.headers.get('content-type')
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const responseText = await response.text();
			this.log('Force inbound response text read', {
				length: responseText.length,
				preview: responseText.substring(0, 200)
			});

			const data = JSON.parse(responseText);
			this.log('Force inbound JSON parsing complete', data);

			if (!data || typeof data !== 'object') {
				throw new Error('Response is not an object');
			}

			if (!data.documents) {
				throw new Error('Missing "documents" field in response');
			}

			if (!Array.isArray(data.documents)) {
				throw new Error('documents field is not an array');
			}

			this.log('Force inbound data validation complete', {
				documentsCount: data.documents.length
			});

			let successCount = 0;
			let errorCount = 0;

			for (let i = 0; i < data.documents.length; i++) {
				const doc = data.documents[i];
				try {
					await this.processForceInboundDocument(doc);
					successCount++;
					this.log(`Force inbound document ${i+1} processed successfully: ${doc.filename || doc.filepath}`);
				} catch (error) {
					console.error(`Force inbound document ${i+1} processing failed:`, error);
					errorCount++;
				}
			}

			const resultMsg = `⚡ Force Inbound sync complete: ${successCount} succeeded, ${errorCount} failed`;
			new Notice(resultMsg);
			this.log(resultMsg);

		} catch (error) {
			const errorMsg = `❌ Force Inbound sync failed: ${error.message}`;
			console.error('[WebhookSync Force Inbound ERROR]', error);
			new Notice(errorMsg);
		}
	}

	/**
	 * NEW: Process Force Inbound document with filepath, filename, content format
	 */
	async processForceInboundDocument(doc: any) {
		if (!doc.filename && !doc.filepath) {
			throw new Error('Document missing filename or filepath');
		}

		if (typeof doc.content !== 'string') {
			throw new Error('Document content is not a string');
		}

		// Use filepath if available, otherwise use filename
		let filePath = doc.filepath || doc.filename;
		
		// Ensure .md extension
		if (!filePath.endsWith('.md')) {
			filePath += '.md';
		}

		this.log('Force inbound file path determined', { 
			filepath: doc.filepath || 'none',
			filename: doc.filename || 'none', 
			final: filePath 
		});

		// Create folder structure if needed
		const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
		if (folderPath) {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder) {
				this.log('Creating folder for force inbound', { path: folderPath });
				await this.app.vault.createFolder(folderPath);
			}
		}

		// Create or update file
		const existingFile = this.app.vault.getAbstractFileByPath(filePath);
		
		if (existingFile instanceof TFile) {
			this.log('Updating existing file (force inbound)', { path: filePath });
			await this.app.vault.modify(existingFile, doc.content);
		} else {
			this.log('Creating new file (force inbound)', { path: filePath });
			await this.app.vault.create(filePath, doc.content);
		}
	}

	/**
	 * Start initial sync of all existing notes
	 */
	async startInitialSync() {
		if (!this.settings.outboundWebhookUrl) {
			new Notice('❌ Outbound webhook URL is not configured. Please set it in settings.');
			return;
		}

		// Get all markdown files
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		if (markdownFiles.length === 0) {
			new Notice('No markdown files found to sync.');
			return;
		}

		// Confirm with user
		const confirmed = await this.confirmInitialSync(markdownFiles.length);
		if (!confirmed) {
			return;
		}

		this.log(`Starting initial sync of ${markdownFiles.length} files`);
		
		// Show progress modal
		this.initialSyncCancelled = false;
		this.initialSyncModal = new InitialSyncModal(this.app, () => {
			this.initialSyncCancelled = true;
		});
		this.initialSyncModal.open();

		// Start processing
		await this.processInitialSync(markdownFiles);
	}

	private async confirmInitialSync(fileCount: number): Promise {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.contentEl.createEl('h2', { text: '🚀 Initial Sync Confirmation' });
			modal.contentEl.createEl('p', { 
				text: `This will sync ${fileCount} existing notes to your webhook endpoint. This operation may take some time.` 
			});
			modal.contentEl.createEl('p', { 
				text: 'Are you sure you want to continue?',
				cls: 'mod-warning'
			});

			const buttonContainer = modal.contentEl.createDiv('button-container');
			
			const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
			cancelBtn.onclick = () => {
				modal.close();
				resolve(false);
			};

			const confirmBtn = buttonContainer.createEl('button', { 
				text: 'Start Sync',
				cls: 'mod-cta'
			});
			confirmBtn.onclick = () => {
				modal.close();
				resolve(true);
			};

			modal.open();
		});
	}

	private async processInitialSync(allFiles: TFile[]) {
		const progress: InitialSyncProgress = {
			total: allFiles.length,
			processed: 0,
			current: '',
			errors: [],
			isRunning: true
		};

		const batchSize = this.settings.initialSyncBatchSize;
		const totalBatches = Math.ceil(allFiles.length / batchSize);
		
		this.log(`Processing ${allFiles.length} files in ${totalBatches} batches of ${batchSize}`);

		try {
			for (let i = 0; i < totalBatches; i++) {
				if (this.initialSyncCancelled) {
					this.log('Initial sync cancelled by user');
					break;
				}

				const startIdx = i * batchSize;
				const endIdx = Math.min(startIdx + batchSize, allFiles.length);
				const batch = allFiles.slice(startIdx, endIdx);

				// Update progress
				progress.current = `Batch ${i + 1}/${totalBatches}: ${batch.map(f => f.name).join(', ')}`;
				this.initialSyncModal?.updateProgress(progress);

				this.log(`Processing batch ${i + 1}/${totalBatches}: ${batch.length} files`);

				// Process batch
				const result = await this.changeQueue?.processInitialSyncBatch(batch);
				
				if (result) {
					progress.processed += result.success;
					progress.errors.push(...result.errors);
				}

				// Update progress
				this.initialSyncModal?.updateProgress(progress);

				// Wait between batches to avoid overwhelming the server
				if (i < totalBatches - 1) {
					await this.delay(1000);
				}
			}

		} catch (error) {
			this.log('Initial sync error:', error);
			progress.errors.push(`Sync error: ${error.message}`);
		} finally {
			progress.isRunning = false;
			progress.current = this.initialSyncCancelled ? 'Sync cancelled' : 'Sync completed';
			this.initialSyncModal?.updateProgress(progress);

			// Show completion notice
			const successCount = progress.processed;
			const errorCount = progress.errors.length;
			const message = this.initialSyncCancelled 
				? `Initial sync cancelled. ${successCount} files were synced.`
				: `Initial sync completed! ${successCount} files synced, ${errorCount} errors.`;
			
			new Notice(message);
			this.log(message);
		}
	}

	private delay(ms: number): Promise {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Setup vault event listeners for real-time sync
	 */
	private setupRealtimeSync() {
		this.stopRealtimeSync();
		
		if (!this.settings.enableRealTimeSync || !this.changeQueue) {
			return;
		}
		
		this.log('Setting up real-time sync listeners');
		
		const createRef = this.app.vault.on('create', (file) => {
			if (this.isMarkdownFile(file)) {
				this.changeQueue?.addChange({
					type: 'create',
					filePath: file.path,
					timestamp: new Date().toISOString(),
					file: file
				}).catch(error => {
					this.log(`Error processing create event for ${file.path}:`, error);
				});
			}
		});
		
		const modifyRef = this.app.vault.on('modify', (file) => {
			if (this.isMarkdownFile(file)) {
				this.changeQueue?.addChange({
					type: 'modify',
					filePath: file.path,
					timestamp: new Date().toISOString(),
					file: file
				}).catch(error => {
					this.log(`Error processing modify event for ${file.path}:`, error);
				});
			}
		});
		
		const deleteRef = this.app.vault.on('delete', (file) => {
			if (this.isMarkdownFile(file)) {
				this.changeQueue?.addChange({
					type: 'delete',
					filePath: file.path,
					oldPath: file.path,
					timestamp: new Date().toISOString()
				}).catch(error => {
					this.log(`Error processing delete event for ${file.path}:`, error);
				});
			}
		});
		
		const renameRef = this.app.vault.on('rename', (file, oldPath) => {
			if (this.isMarkdownFile(file)) {
				this.changeQueue?.addChange({
					type: 'rename',
					filePath: file.path,
					oldPath: oldPath,
					timestamp: new Date().toISOString(),
					file: file
				}).catch(error => {
					this.log(`Error processing rename event for ${file.path}:`, error);
				});
			}
		});
		
		this.vaultEventRefs = [createRef, modifyRef, deleteRef, renameRef];
		this.vaultEventRefs.forEach(ref => this.registerEvent(ref));
		
		this.log('Real-time sync listeners activated');
	}
	
	private stopRealtimeSync() {
		if (this.vaultEventRefs.length > 0) {
			this.log('Stopping real-time sync listeners');
			this.vaultEventRefs = [];
		}
	}
	
	private isMarkdownFile(file: any): file is TFile {
		return file instanceof TFile && file.extension === 'md';
	}
	
	private toggleRealtimeSync() {
		this.settings.enableRealTimeSync = !this.settings.enableRealTimeSync;
		this.saveSettings();
		
		const status = this.settings.enableRealTimeSync ? 'enabled' : 'disabled';
		const icon = this.settings.enableRealTimeSync ? '✅' : '⏹️';
		new Notice(`${icon} Real-time sync ${status}`);
	}

	// === EXISTING INBOUND SYNC METHODS (Queue-based) ===
	
	async syncFromWebhook() {
		if (!this.settings.webhookUrl) {
			new Notice('❌ Webhook URL is not configured. Please set it in settings.');
			return;
		}

		this.log('=== Starting inbound sync (queue-based) ===', { url: this.settings.webhookUrl });
		new Notice('🔄 Syncing documents from webhook...');

		try {
			this.log('Sending HTTP request...');
			const response = await fetch(this.settings.webhookUrl);
			
			this.log('Response received', {
				status: response.status,
				ok: response.ok,
				contentType: response.headers.get('content-type')
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const responseText = await response.text();
			this.log('Response text read', {
				length: responseText.length,
				preview: responseText.substring(0, 200)
			});

			const data = JSON.parse(responseText);
			this.log('JSON parsing complete', data);

			if (!data || typeof data !== 'object') {
				throw new Error('Response is not an object');
			}

			if (!data.documents) {
				throw new Error('Missing "documents" field in response');
			}

			if (!Array.isArray(data.documents)) {
				throw new Error('documents field is not an array');
			}

			this.log('Data validation complete', {
				documentsCount: data.documents.length
			});

			let successCount = 0;
			let errorCount = 0;

			for (let i = 0; i < data.documents.length; i++) {
				const doc = data.documents[i];
				try {
					await this.processDocument(doc);
					successCount++;
					this.log(`Document ${i+1} processed successfully: ${doc.filename}`);
				} catch (error) {
					console.error(`Document ${i+1} processing failed:`, error);
					errorCount++;
				}
			}

			const resultMsg = `✅ Sync complete: ${successCount} succeeded, ${errorCount} failed`;
			new Notice(resultMsg);
			this.log(resultMsg);

		} catch (error) {
			const errorMsg = `❌ Sync failed: ${error.message}`;
			console.error('[WebhookSync ERROR]', error);
			new Notice(errorMsg);
		}
	}

	async processDocument(doc: any) {
		if (!doc.filename) {
			throw new Error('Document missing filename');
		}

		if (typeof doc.content !== 'string') {
			throw new Error('Document content is not a string');
		}

		let filePath = doc.filename;
		
		if (doc.path) {
			filePath = `${doc.path}/${doc.filename}`;
		}

		if (!filePath.endsWith('.md')) {
			filePath += '.md';
		}

		this.log('File path determined', { 
			original: doc.filename, 
			final: filePath 
		});

		if (doc.path) {
			const folder = this.app.vault.getAbstractFileByPath(doc.path);
			if (!folder) {
				this.log('Creating folder', { path: doc.path });
				await this.app.vault.createFolder(doc.path);
			}
		}

		const existingFile = this.app.vault.getAbstractFileByPath(filePath);
		
		if (existingFile instanceof TFile) {
			this.log('Updating existing file', { path: filePath });
			await this.app.vault.modify(existingFile, doc.content);
		} else {
			this.log('Creating new file', { path: filePath });
			await this.app.vault.create(filePath, doc.content);
		}
	}

	startPeriodicSync() {
		this.stopPeriodicSync();

		if (this.settings.syncInterval > 0) {
			const intervalMs = this.settings.syncInterval * 60 * 1000;
			this.syncIntervalId = window.setInterval(() => {
				this.syncFromWebhook();
			}, intervalMs);
			this.log(`Periodic sync started: every ${this.settings.syncInterval} minutes`);
		}
	}

	stopPeriodicSync() {
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
			this.log('Periodic sync stopped');
		}
	}
}

class WebhookSyncSettingTab extends PluginSettingTab {
	plugin: WebhookSyncPlugin;

	constructor(app: App, plugin: WebhookSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h2', {text: '🔄 Webhook Sync Settings'});

		// === FORCE INBOUND SYNC (NEW SECTION) ===
		containerEl.createEl('h3', {text: '⚡ Force Inbound Sync (Immediate sync from webhook)'});
		
		new Setting(containerEl)
			.setName('Force Inbound Webhook URL')
			.setDesc('Webhook endpoint for immediate document sync (expects filepath, filename, content format)')
			.addText(text => text
				.setPlaceholder('https://your-webhook.com/force-inbound')
				.setValue(this.plugin.settings.forceInboundWebhookUrl)
				.onChange(async (value) => {
					this.plugin.settings.forceInboundWebhookUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto Force Inbound on Startup')
			.setDesc('Automatically trigger force inbound sync when Obsidian starts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoForceInboundOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.autoForceInboundOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Force Inbound Sync Now')
			.setDesc('Manually trigger force inbound sync right now')
			.addButton(button => button
				.setButtonText('⚡ Force Sync Now')
				.setCta()
				.onClick(() => {
					this.plugin.forceInboundSync();
				}));

		// === REGULAR INBOUND SYNC ===
		containerEl.createEl('h3', {text: '📥 Regular Inbound Sync (Queue-based sync from webhook)'});
		
		new Setting(containerEl)
			.setName('Inbound Webhook URL')
			.setDesc('Webhook endpoint to fetch documents from (e.g., n8n webhook)')
			.addText(text => text
				.setPlaceholder('https://your-n8n-instance.com/webhook/fetch-docs')
				.setValue(this.plugin.settings.webhookUrl)
				.onChange(async (value) => {
					this.plugin.settings.webhookUrl = value;
					await this.plugin.saveSettings();
				}));

		// === OUTBOUND SYNC ===
		containerEl.createEl('h3', {text: '📤 Outbound Sync (from Obsidian to webhook)'});
		
		new Setting(containerEl)
			.setName('Enable Real-time Sync')
			.setDesc('Automatically sync changes to external webhook when files are modified')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableRealTimeSync)
				.onChange(async (value) => {
					this.plugin.settings.enableRealTimeSync = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Outbound Webhook URL')
			.setDesc('Webhook endpoint to send changes to when files are modified')
			.addText(text => text
				.setPlaceholder('https://your-n8n-instance.com/webhook/receive-changes')
				.setValue(this.plugin.settings.outboundWebhookUrl)
				.onChange(async (value) => {
					this.plugin.settings.outboundWebhookUrl = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Debounce Delay (seconds)')
			.setDesc('Wait time before sending changes to avoid too many requests')
			.addSlider(slider => slider
				.setLimits(1, 10, 0.5)
				.setValue(this.plugin.settings.debounceDelayMs / 1000)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.debounceDelayMs = value * 1000;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Batch Size')
			.setDesc('Maximum number of changes to send in one request')
			.addSlider(slider => slider
				.setLimits(1, 50, 1)
				.setValue(this.plugin.settings.batchSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.batchSize = value;
					await this.plugin.saveSettings();
				}));

		// === INITIAL SYNC ===
		containerEl.createEl('h3', {text: '🚀 Initial Sync (Send all existing notes)'});
		
		new Setting(containerEl)
			.setName('Initial Sync Batch Size')
			.setDesc('Number of files to send per batch during initial sync')
			.addSlider(slider => slider
				.setLimits(1, 20, 1)
				.setValue(this.plugin.settings.initialSyncBatchSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.initialSyncBatchSize = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Start Initial Sync')
			.setDesc('Send all existing notes in your vault to the outbound webhook. Use this to sync existing notes to your database.')
			.addButton(button => button
				.setButtonText('🚀 Start Initial Sync')
				.setCta()
				.onClick(async () => {
					await this.plugin.startInitialSync();
				}));

		// === GENERAL ===
		containerEl.createEl('h3', {text: '⚙️ General Settings'});
		
		new Setting(containerEl)
			.setName('Enable Debug Logging')
			.setDesc('Output detailed logs to console (open with Ctrl+Shift+I)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDebugLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugLogging = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync Interval (minutes)')
			.setDesc('How often to automatically sync. Set to 0 to disable automatic sync.')
			.addSlider(slider => slider
				.setLimits(0, 60, 1)
				.setValue(this.plugin.settings.syncInterval)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.syncInterval = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync on startup')
			.setDesc('Automatically sync documents when Obsidian starts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSyncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.autoSyncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Manual Regular Sync')
			.setDesc('Manually trigger regular inbound sync right now')
			.addButton(button => button
				.setButtonText('🔄 Regular Sync Now')
				.setCta()
				.onClick(() => {
					this.plugin.syncFromWebhook();
				}));

		// === DOCUMENTATION ===
		this.addDocumentationSection(containerEl);
	}
	
	private addDocumentationSection(containerEl: HTMLElement) {
		containerEl.createEl('h3', {text: '📋 Webhook Payload Formats'});
		
		// Force Inbound format
		containerEl.createEl('h4', {text: 'Force Inbound (Expected Response Format)'});
		containerEl.createEl('p', {text: 'Your force inbound webhook should return JSON in this format:'});
		
		const forceInboundExample = {
			documents: [
				{
					filepath: "folder/document1.md",
					filename: "document1.md",
					content: "# Document 1\\n\\nContent here..."
				},
				{
					filepath: "notes/another-note.md", 
					filename: "another-note.md",
					content: "# Another Note\\n\\nMore content..."
				}
			]
		};
		
		const forceInboundCodeEl = containerEl.createEl('pre');
		forceInboundCodeEl.createEl('code', {text: JSON.stringify(forceInboundExample, null, 2)});
		
		// Regular Inbound format
		containerEl.createEl('h4', {text: 'Regular Inbound (Expected Response Format)'});
		containerEl.createEl('p', {text: 'Your regular inbound webhook should return JSON in this format:'});
		
		const inboundExample = {
			documents: [
				{
					filename: "document1",
					content: "# Document 1\\n\\nContent here...",
					path: "folder/subfolder"
				},
				{
					filename: "document2.md",
					content: "# Document 2\\n\\nMore content..."
				}
			]
		};
		
		const inboundCodeEl = containerEl.createEl('pre');
		inboundCodeEl.createEl('code', {text: JSON.stringify(inboundExample, null, 2)});
		
		// Outbound format
		containerEl.createEl('h4', {text: 'Outbound (Sent to Your Webhook)'});
		containerEl.createEl('p', {text: 'Your outbound webhook will receive POST requests with this format:'});
		
		const outboundExample = {
			timestamp: new Date().toISOString(),
			isInitialSync: false,
			changes: [
				{
					type: "create",
					filePath: "folder/new-note.md",
					fileName: "new-note.md",
					folder: "folder",
					content: "# New content...",
					timestamp: new Date().toISOString(),
					ctime: 1704110400000,
					mtime: 1704110400000,
					size: 1024
				},
				{
					type: "rename",
					filePath: "folder/renamed-note.md",
					oldPath: "folder/old-name.md",
					fileName: "renamed-note.md",
					content: "# Same content...",
					timestamp: new Date().toISOString()
				},
				{
					type: "delete",
					filePath: "folder/deleted-note.md",
					oldPath: "folder/deleted-note.md",
					timestamp: new Date().toISOString()
				}
			]
		};
		
		const outboundCodeEl = containerEl.createEl('pre');
		outboundCodeEl.createEl('code', {text: JSON.stringify(outboundExample, null, 2)});
		
		containerEl.createEl('p', {text: 'Note: isInitialSync flag indicates if this is from the initial sync operation. oldPath is included for rename and delete operations. Force Inbound expects filepath (full path) and filename fields.'});
	}
}