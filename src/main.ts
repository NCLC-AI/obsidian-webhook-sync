import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

interface WebhookSyncSettings {
	webhookUrl: string;
	syncInterval: number; // in minutes
	autoSyncOnStartup: boolean;
	enableDebugLogging: boolean;
}

const DEFAULT_SETTINGS: WebhookSyncSettings = {
	webhookUrl: '',
	syncInterval: 1,
	autoSyncOnStartup: true,
	enableDebugLogging: true
}

export default class WebhookSyncPlugin extends Plugin {
	settings: WebhookSyncSettings;
	syncIntervalId: number | null = null;

	async onload() {
		await this.loadSettings();

		// Add ribbon icon
		this.addRibbonIcon('sync', 'Sync from webhook', () => {
			this.syncFromWebhook();
		});

		// Add command
		this.addCommand({
			id: 'sync-from-webhook',
			name: 'Sync documents from webhook',
			callback: () => {
				this.syncFromWebhook();
			}
		});

		// Add settings tab
		this.addSettingTab(new WebhookSyncSettingTab(this.app, this));

		// Auto-sync on startup if enabled
		if (this.settings.autoSyncOnStartup) {
			setTimeout(() => {
				this.syncFromWebhook();
			}, 2000);
		}

		// Start periodic sync
		this.startPeriodicSync();
		console.log('🔄 Webhook Sync plugin loaded');
	}

	onunload() {
		this.stopPeriodicSync();
		console.log('🔄 Webhook Sync plugin unloaded');
	}

	/**
	 * Log debug messages to console
	 */
	log(message: string, data?: any) {
		if (this.settings.enableDebugLogging) {
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
	}

	/**
	 * Main sync function - fetches documents from webhook endpoint
	 */
	async syncFromWebhook() {
		if (!this.settings.webhookUrl) {
			new Notice('❌ Webhook URL is not configured. Please set it in settings.');
			return;
		}

		this.log('=== Starting sync ===', { url: this.settings.webhookUrl });
		new Notice('🔄 Syncing documents from webhook...');

		try {
			// 1. Send HTTP request
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

			// 2. Read response text
			const responseText = await response.text();
			this.log('Response text read', {
				length: responseText.length,
				preview: responseText.substring(0, 200)
			});

			// 3. Parse JSON
			const data = JSON.parse(responseText);
			this.log('JSON parsing complete', data);

			// 4. Validate data structure - expecting n8n response format
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
				documentsCount: data.documents.length,
				firstDoc: data.documents.length > 0 ? {
					filename: data.documents[0].filename,
					hasContent: !!data.documents[0].content,
					path: data.documents[0].path
				} : 'no documents'
			});

			// 5. Process documents
			let successCount = 0;
			let errorCount = 0;

			for (let i = 0; i < data.documents.length; i++) {
				const doc = data.documents[i];
				try {
					this.log(`Processing document ${i+1}`, {
						filename: doc.filename,
						contentLength: doc.content ? doc.content.length : 0,
						path: doc.path
					});

					await this.processDocument(doc);
					successCount++;
					this.log(`Document ${i+1} processed successfully: ${doc.filename}`);

				} catch (error) {
					console.error(`Document ${i+1} processing failed:`, error);
					errorCount++;
				}
			}

			// 6. Show result notification
			const resultMsg = `✅ Sync complete: ${successCount} succeeded, ${errorCount} failed`;
			new Notice(resultMsg);
			this.log(resultMsg);

		} catch (error) {
			const errorMsg = `❌ Sync failed: ${error.message}`;
			console.error('[WebhookSync ERROR]', error);
			new Notice(errorMsg);
		}
	}

	/**
	 * Process a single document - create or update file
	 */
	async processDocument(doc: any) {
		// Input validation
		if (!doc.filename) {
			throw new Error('Document missing filename');
		}

		if (typeof doc.content !== 'string') {
			throw new Error('Document content is not a string');
		}

		// Build file path
		let filePath = doc.filename;
		
		// Include path if provided
		if (doc.path) {
			filePath = `${doc.path}/${doc.filename}`;
		}

		// Add .md extension if not present
		if (!filePath.endsWith('.md')) {
			filePath += '.md';
		}

		this.log('File path determined', { 
			original: doc.filename, 
			final: filePath 
		});

		// Create folder if needed
		if (doc.path) {
			const folder = this.app.vault.getAbstractFileByPath(doc.path);
			if (!folder) {
				this.log('Creating folder', { path: doc.path });
				await this.app.vault.createFolder(doc.path);
			}
		}

		// Create or update file
		const existingFile = this.app.vault.getAbstractFileByPath(filePath);
		
		if (existingFile instanceof TFile) {
			// Update existing file
			this.log('Updating existing file', { path: filePath });
			await this.app.vault.modify(existingFile, doc.content);
		} else {
			// Create new file
			this.log('Creating new file', { path: filePath });
			await this.app.vault.create(filePath, doc.content);
		}
	}

	/**
	 * Start periodic sync timer
	 */
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

	/**
	 * Stop periodic sync timer
	 */
	stopPeriodicSync() {
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
			this.log('Periodic sync stopped');
		}
	}
}

/**
 * Settings tab for configuring webhook sync
 */
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

		// Webhook URL setting
		new Setting(containerEl)
			.setName('Webhook URL')
			.setDesc('The webhook endpoint URL to fetch documents from')
			.addText(text => text
				.setPlaceholder('https://your-n8n-instance.com/webhook/your-id')
				.setValue(this.plugin.settings.webhookUrl)
				.onChange(async (value) => {
					this.plugin.settings.webhookUrl = value;
					await this.plugin.saveSettings();
				}));

		// Debug logging toggle
		new Setting(containerEl)
			.setName('Enable Debug Logging')
			.setDesc('Output detailed logs to console (open with Ctrl+Shift+I)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDebugLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugLogging = value;
					await this.plugin.saveSettings();
				}));

		// Sync interval setting
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

		// Auto sync on startup
		new Setting(containerEl)
			.setName('Auto sync on startup')
			.setDesc('Automatically sync documents when Obsidian starts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSyncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.autoSyncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		// Manual sync button
		new Setting(containerEl)
			.setName('Manual Sync')
			.setDesc('Manually trigger sync right now')
			.addButton(button => button
				.setButtonText('🔄 Sync Now')
				.setCta()
				.onClick(() => {
					this.plugin.syncFromWebhook();
				}));

		// API response format documentation
		containerEl.createEl('h3', {text: '📋 Expected Response Format'});
		containerEl.createEl('p', {text: 'Your webhook endpoint should return JSON in the following format:'});
		
		const codeEl = containerEl.createEl('pre');
		codeEl.createEl('code', {text: `{
  "documents": [
    {
      "filename": "document1",
      "content": "# Document 1\\n\\nContent here...",
      "path": "folder/subfolder"
    },
    {
      "filename": "document2.md", 
      "content": "# Document 2\\n\\nMore content..."
    }
  ]
}`});

		containerEl.createEl('p', {text: 'Note: The "path" field is optional. If not provided, files will be created in the root of your vault.'});
	}
}
