# Image Queue Chrome Extension

A production-ready Chrome Extension (Manifest V3) designed for article writers who need to generate multiple AI images from prompts sequentially using their existing logged-in ChatGPT browser session, process them locally (conversion, resizing, quality control), and download them as a ZIP archive.

No API keys or ChatGPT subscriptions are required. Everything runs locally in the browser!

## Features

- **Sequential Generation**: Process prompts one at a time to prevent rate limits and avoid overwhelming the ChatGPT interface.
- **Background Processing**: Start generation and switch to another tab to continue writing. The extension manages the queue via a Manifest V3 background service worker.
- **Robust Persistence**: The queue state is saved to `chrome.storage.local`. It survives popup closures, service worker restarts, and temporary connection issues.
- **Local Image Processing**: Convert images to WebP, JPG, or PNG, adjust quality, resize (downscale only), and apply a custom prefix—all locally in the browser via `OffscreenCanvas`.
- **Bulk Download**: Compresses all processed images into a `.zip` file locally using JSZip.
- **Detailed Diagnostics & Logs**: Interactive logging and system state indicators for troubleshooting.

---

## Directory Structure

```text
src/
  background/
    service-worker.ts       # Orchestrates the queue, handles downloads and messages
    tab-manager.ts          # Manages tab query, creation, and injection
    chatgpt-provider.ts     # Wrapper provider implementing ImageGenerationProvider

  content/
    chatgpt-adapter.ts      # Handles composer insertion, send button click, image detection
    chatgpt-detector.ts     # Inspects ChatGPT DOM state (logged in, ready, busy)
    chatgpt-selectors.ts    # Centralized CSS selectors for easy ChatGPT updates
    content-main.ts         # Injected script receiving commands and running adapter

  popup/
    popup.html / .css / .ts # Modern, beautiful dark-themed popup UI

  options/
    options.html / .css / .ts # settings, diagnostics, and log viewer

  queue/
    queue-manager.ts        # Sequential state machine that manages the queue
    queue-types.ts          # State definitions, helpers, and display configuration

  downloads/
    image-downloader.ts     # Wraps chrome.downloads API

  processing/
    image-processor.ts      # Canvas-based resizing/conversion (WebP, JPG, PNG)
    zip-builder.ts          # Local ZIP creation via JSZip

  storage/
    storage.ts              # Settings and queue metadata storage
    image-store.ts          # IndexedDB wrapper for high-capacity blob storage

  shared/
    messages.ts             # Type-safe messaging definitions
    types.ts                # Shared interface definitions
    constants.ts            # Timeouts, limits, and defaults
    logger.ts               # Structured logger storing logs in storage.local
```

---

## Installation

### Prerequisites
- Node.js (v18+)
- Google Chrome

### Steps
1. Clone or download this repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```
4. Open Google Chrome and navigate to `chrome://extensions`.
5. Enable **Developer mode** (toggle switch in the top right).
6. Click **Load unpacked** in the top left.
7. Select the `dist/` directory inside this project folder.

---

## Development Instructions

To run in development mode (with watchers and source maps):
```bash
npm run dev
```

This will run Vite in watch mode and recompile files when modifications are saved. Note that for Chrome extensions, you must manually reload the extension on the `chrome://extensions` page after compilation completes.

### Running Tests
Unit tests cover the Queue State Machine, Image Processing, and ZIP creation.
```bash
npm run test
```

---

## Architecture & How It Works

### Provider Abstraction
To ensure ChatGPT UI changes do not break the rest of the extension, we decouple the Queue Manager using the `ImageGenerationProvider` interface:

```typescript
export interface ImageGenerationProvider {
  isAvailable(): Promise<boolean>;
  generateImage(prompt: string): Promise<GeneratedImage>;
}
```

The `QueueManager` only interacts with this interface. The `ChatGPTProvider` translates queue requests into messaging commands that go to the content script.

### Inactive Tab Limitations & Workarounds
1. **Throttled Timers**: When the ChatGPT tab is in the background, Chrome throttles standard JavaScript timers (`setTimeout`/`setInterval`) to as slow as once per minute. To solve this, we use a `MutationObserver` on the page DOM. It triggers immediately on DOM mutation (e.g. when the image element appears), bypassing timer throttling completely.
2. **Service Worker Termination**: Manifest V3 background service workers sleep after ~30 seconds of inactivity. During generation (which can take >1 min), the content script maintains a long-lived Port (`chrome.runtime.connect`) with the service worker. This keep-alive port forces the service worker to stay awake.
3. **Storage Limitations**: Storing high-resolution image blobs in `chrome.storage.local` will quickly trigger size limit errors (10MB default). We store metadata in `chrome.storage.local` but use **IndexedDB** in the offscreen document context to hold the raw binary `Blob` data.

---

## Troubleshooting & Diagnostics

- **ChatGPT tab unavailable**: Make sure you have ChatGPT open in a tab and are logged in. The extension automatically looks for `chatgpt.com`. If you use a custom domain, you can change it in the extension settings page.
- **Generation fails**: Check the diagnostics section in the settings page. Verify if the content script is running and if the downloads permission is active.
- **Inspect Logs**: Open the extension settings page (`chrome-extension://<id>/src/options/options.html`) and view the **Activity Log** section to see step-by-step debug actions.
- **Service Worker Inspection**: If you need to debug background processes, go to `chrome://extensions`, locate the "Image Queue" extension, and click the **service worker** link to open DevTools.
