# Webhook Sync Plugin for Obsidian

A plugin that automatically syncs markdown documents from external webhook endpoints into your Obsidian vault.

## Features

- 🔄 Automatic document synchronization from webhook endpoints
- ⏰ Periodic auto-sync (configurable 1-60 minute intervals)
- 🚀 Auto-sync on app startup
- 📁 Folder structure support
- 🔧 Detailed debug logging
- 📱 Desktop and mobile support

## Installation

### Manual Installation

1. Download the latest release files from [releases page](https://github.com/[your-username]/obsidian-webhook-sync/releases):
   - `main.js`
   - `manifest.json` 
   - `styles.css`

2. Create a folder named `webhook-sync` in your vault's `.obsidian/plugins/` directory

3. Copy the downloaded files into the `webhook-sync` folder

4. Restart Obsidian and enable the plugin in Settings → Community plugins

## Usage

1. Go to **Settings → Webhook Sync** and configure your webhook URL
2. Test with **Sync Now** button
3. Configure periodic sync interval if desired
4. Enable auto-sync on startup (optional)

## Webhook Response Format

Your webhook endpoint must return JSON in this format:

```json
{
  "documents": [
    {
      "filename": "document-name",
      "content": "# Title\n\nMarkdown content here...",
      "path": "optional/folder/path"
    }
  ]
}
