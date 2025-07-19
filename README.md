# Webhook Sync Plugin for Obsidian

A comprehensive plugin that provides **bidirectional synchronization** between Obsidian and external webhook endpoints, enabling seamless integration with databases, automation platforms (like n8n), and other external systems.

## 🚀 Features

### 📥 Inbound Sync (Webhook → Obsidian)
- 🔄 Automatic document synchronization from webhook endpoints
- ⏰ Periodic auto-sync (configurable 1-60 minute intervals)
- 🚀 Auto-sync on app startup
- 📁 Folder structure support
- 🔧 Manual sync trigger

### 📤 Outbound Sync (Obsidian → Webhook)
- ⚡ **Real-time sync**: Automatically send changes when files are created, modified, deleted, or renamed
- 🎯 **Smart debouncing**: Configurable delay to avoid excessive webhook calls
- 📦 **Batch processing**: Send multiple changes in optimized batches
- 🔄 **Change queue management**: Reliable delivery with automatic retries
- 🏷️ **Rich metadata**: Includes timestamps, file stats, and change types

### 🔄 Initial Sync
- 🚀 **Bulk export**: Send all existing vault notes to your webhook endpoint
- 📊 **Progress tracking**: Visual progress modal with real-time updates
- 🛡️ **Batch control**: Configurable batch sizes to prevent server overload
- ⏹️ **Cancellable operation**: Stop sync process at any time

### 🛠️ General Features
- 🔧 Detailed debug logging
- 📱 Desktop and mobile support
- ⚙️ Comprehensive settings panel
- 🔄 Ribbon icon for quick sync access
- ⌨️ Command palette integration

## 📦 Installation

### Manual Installation

1. Download the latest release files from [releases page](https://github.com/NCLC-AI/obsidian-webhook-sync/releases):
   - `main.js`
   - `manifest.json` 
   - `styles.css`

2. Create a folder named `webhook-sync` in your vault's `.obsidian/plugins/` directory

3. Copy the downloaded files into the `webhook-sync` folder

4. Restart Obsidian and enable the plugin in Settings → Community plugins

## 🔧 Configuration

### Inbound Sync Setup
1. Go to **Settings → Webhook Sync → Inbound Sync**
2. Enter your **Inbound Webhook URL** (endpoint that provides documents)
3. Configure **Sync Interval** (0 to disable periodic sync)
4. Enable **Auto sync on startup** if desired

### Outbound Sync Setup
1. Go to **Settings → Webhook Sync → Outbound Sync**
2. Enter your **Outbound Webhook URL** (endpoint that receives changes)
3. Enable **Real-time Sync**
4. Adjust **Debounce Delay** (1-10 seconds)
5. Set **Batch Size** (1-50 changes per request)

### Initial Sync Setup
1. Configure your outbound webhook URL first
2. Set **Initial Sync Batch Size** (1-20 files per batch)
3. Click **🚀 Start Initial Sync** when ready

## 📡 Webhook Formats

### Inbound Format (Expected Response)
Your inbound webhook endpoint should return JSON in this format:

```json
{
  "documents": [
    {
      "filename": "document-name",
      "content": "# Title\n\nMarkdown content here...",
      "path": "optional/folder/path"
    },
    {
      "filename": "another-document.md",
      "content": "# Another Document\n\nMore content..."
    }
  ]
}
```

Outbound Format (Sent to Your Webhook)
Your outbound webhook will receive POST requests with this format:

```json
{
  "timestamp": "2024-01-01T12:00:00.000Z",
  "isInitialSync": false,
  "changes": [
    {
      "type": "create",
      "filePath": "folder/new-note.md",
      "fileName": "new-note.md", 
      "folder": "folder",
      "content": "# New content...",
      "timestamp": "2024-01-01T12:00:00.000Z",
      "ctime": 1704110400000,
      "mtime": 1704110400000,
      "size": 1024
    },
    {
      "type": "modify",
      "filePath": "existing-note.md",
      "fileName": "existing-note.md",
      "folder": "",
      "content": "# Updated content...",
      "timestamp": "2024-01-01T12:01:00.000Z",
      "ctime": 1704110400000,
      "mtime": 1704110460000,
      "size": 1156
    },
    {
      "type": "rename",
      "filePath": "folder/renamed-note.md",
      "oldPath": "folder/old-name.md",
      "fileName": "renamed-note.md",
      "content": "# Same content...",
      "timestamp": "2024-01-01T12:02:00.000Z"
    },
    {
      "type": "delete",
      "filePath": "folder/deleted-note.md",
      "oldPath": "folder/deleted-note.md", 
      "timestamp": "2024-01-01T12:03:00.000Z"
    }
  ]
}
```

## 🎮 Usage

### Commands
- **Sync documents from webhook**: Manual inbound sync
- **Toggle real-time sync**: Enable/disable outbound real-time sync  
- **Initial Sync: Send all notes to webhook**: Bulk export all vault notes

### Ribbon Icon
Click the sync icon (🔄) in the ribbon to trigger manual inbound sync.

## 🔄 Sync Types

### 1. Inbound Sync (Webhook → Obsidian)
- Fetches documents from your configured webhook endpoint
- Creates new files or updates existing ones
- Maintains folder structure as specified in the webhook response
- Triggered manually, on startup, or periodically

### 2. Outbound Sync (Obsidian → Webhook)  
- Monitors vault for file changes (create, modify, delete, rename)
- Sends changes to your configured outbound webhook
- Uses intelligent debouncing and batching for efficiency
- Includes full file content and metadata

### 3. Initial Sync (Bulk Export)
- One-time operation to sync all existing vault notes
- Processes files in configurable batches
- Shows progress with detailed modal
- Sends `isInitialSync: true` flag in webhook payload

## 🛠️ Integration Examples

### n8n Workflow Integration
Perfect for integrating with n8n automation workflows:

1. **Inbound**: n8n workflow fetches data from databases/APIs → formats as documents → Obsidian imports
2. **Outbound**: Obsidian changes → n8n receives webhook → updates databases/external systems
3. **Initial Sync**: Export entire vault to populate external databases

### Database Synchronization
- Sync with Supabase, Airtable, Notion, or any database with webhook support
- Maintain bidirectional sync between your notes and structured data
- Perfect for knowledge management systems

## 🔧 Advanced Configuration

### Debouncing
Prevents excessive webhook calls by waiting for a configurable delay (1-10 seconds) after the last change before sending the batch.

### Batching  
Combines multiple file changes into single webhook requests for efficiency. Configurable batch sizes (1-50 changes).

### Error Handling
- Automatic retry logic for failed webhook requests
- Detailed error logging for troubleshooting
- Queue management prevents data loss

## 🐛 Troubleshooting

### Debug Logging
1. Enable **Debug Logging** in settings
2. Open Developer Console (Ctrl+Shift+I)
3. Look for `[WebhookSync]` prefixed logs

### Common Issues
- **Webhook URL not responding**: Check URL accessibility and CORS settings
- **Real-time sync not working**: Ensure outbound webhook URL is configured
- **Large vault initial sync fails**: Reduce initial sync batch size

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues, feature requests, or pull requests.

## 📄 License

MIT License - feel free to use and modify as needed.