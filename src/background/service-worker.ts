import { QueueManager } from '../queue/queue-manager';
import { ChatGPTProvider } from './chatgpt-provider';
import { GeminiProvider } from './gemini-provider';
import {
  findChatGPTTab,
  openChatGPTTab,
  ensureContentScript,
  checkChatGPTStatus,
  findGeminiTab,
  openGeminiTab,
  checkGeminiStatus,
} from './tab-manager';
import { settingsStorage, queueStorage } from '../storage/storage';
import { imageStore } from '../storage/image-store';
import { logger } from '../shared/logger';
import {
  MSG,
  createMessage,
  type ExtensionMessage,
  type StartQueuePayload,
  type RetryItemPayload,
  type RemoveItemPayload,
  type SkipItemPayload,
  type ImageGeneratedPayload,
  type GenerationFailedPayload,
  type ProcessImagesPayload,
  type SaveSettingsPayload,
} from '../shared/messages';
import type { QueueData, DiagnosticsInfo, ProcessingOptions } from '../shared/types';
import {
  QUEUE_RECOVERY_ALARM,
  QUEUE_RECOVERY_INTERVAL_MIN,
} from '../shared/constants';

// ─── Singletons ────────────────────────────────────────────────

const queueManager = new QueueManager();
const chatgptProvider = new ChatGPTProvider();
const geminiProvider = new GeminiProvider();

async function getActiveProvider(): Promise<ChatGPTProvider | GeminiProvider> {
  const settings = await settingsStorage.load();
  return settings.activeProvider === 'gemini' ? geminiProvider : chatgptProvider;
}

// ─── Image Download Handler ────────────────────────────────────

/**
 * Download an image from a URL and store it in IndexedDB.
 * Returns true if successful, false otherwise.
 */
async function downloadAndStoreImage(
  itemId: string,
  imageUrl: string
): Promise<boolean> {
  try {
    logger.info('Downloading image', { itemId, url: imageUrl.slice(0, 80) });

    let blob: Blob;

    if (imageUrl.startsWith('data:')) {
      // Handle data URLs
      const response = await fetch(imageUrl);
      blob = await response.blob();
    } else {
      // Handle regular URLs — fetch with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(imageUrl, {
          signal: controller.signal,
          credentials: 'include',
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        blob = await response.blob();
      } finally {
        clearTimeout(timeout);
      }
    }

    // Validate the blob
    if (!blob || blob.size === 0) {
      logger.error('Downloaded blob is empty', { itemId });
      return false;
    }

    if (!blob.type.startsWith('image/')) {
      // Try to detect image from content
      const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      const isPNG = header[0] === 0x89 && header[1] === 0x50;
      const isJPG = header[0] === 0xFF && header[1] === 0xD8;
      const isWebP = header[0] === 0x52 && header[1] === 0x49;

      if (!isPNG && !isJPG && !isWebP) {
        logger.error('Downloaded content is not a valid image', {
          itemId,
          type: blob.type,
          size: blob.size,
        });
        return false;
      }
    }

    // Get dimensions via createImageBitmap (works in service worker)
    let width: number | undefined;
    let height: number | undefined;
    try {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {
      // Can't get dimensions, not critical
    }

    // Store in IndexedDB
    await imageStore.store(itemId, blob, width, height);
    logger.info('Image stored', {
      itemId,
      size: blob.size,
      width,
      height,
    });

    return true;
  } catch (err) {
    logger.error('Image download failed', {
      itemId,
      error: String(err),
    });
    return false;
  }
}

function updateExtensionBadge(queue: QueueData | null): void {
  if (!queue || queue.items.length === 0 || queue.state === 'idle') {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  const total = queue.items.length;
  const completedCount = queue.items.filter((i) => i.status === 'completed').length;
  const failedCount = queue.items.filter((i) => i.status === 'failed').length;
  const pendingCount = total - completedCount; // remaining items (including active generating + waiting)

  if (queue.state === 'completed') {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // green
  } else if (queue.state === 'paused') {
    chrome.action.setBadgeText({ text: pendingCount > 0 ? String(pendingCount) : '||' });
    chrome.action.setBadgeBackgroundColor({ color: '#eab308' }); // amber yellow
  } else if (queue.state === 'error' || failedCount > 0) {
    chrome.action.setBadgeText({ text: String(pendingCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // red
  } else {
    chrome.action.setBadgeText({ text: String(pendingCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ff5c35' }); // brand orange
  }
}

// ─── Queue Manager Setup ───────────────────────────────────────

queueManager.setProvider(chatgptProvider);
queueManager.onImageDownload = downloadAndStoreImage;

// Bind provider callbacks for stateless recovery when service worker restarts
chatgptProvider.onExternalCompleted = (itemId, imageUrl) => {
  queueManager.handleExternalItemCompleted(itemId, imageUrl).catch(err => {
    logger.error('Failed to process external ChatGPT item completion', { error: String(err) });
  });
};
chatgptProvider.onExternalFailed = (itemId, error) => {
  queueManager.handleExternalItemFailed(itemId, error).catch(err => {
    logger.error('Failed to process external ChatGPT item failure', { error: String(err) });
  });
};

geminiProvider.onExternalCompleted = (itemId, imageUrl) => {
  queueManager.handleExternalItemCompleted(itemId, imageUrl).catch(err => {
    logger.error('Failed to process external Gemini item completion', { error: String(err) });
  });
};
geminiProvider.onExternalFailed = (itemId, error) => {
  queueManager.handleExternalItemFailed(itemId, error).catch(err => {
    logger.error('Failed to process external Gemini item failure', { error: String(err) });
  });
};

// Broadcast queue updates to popup and update badge
queueManager.setOnUpdate((queue: QueueData) => {
  updateExtensionBadge(queue);
  try {
    chrome.runtime.sendMessage(
      createMessage(MSG.QUEUE_STATUS_UPDATE, queue)
    ).catch(() => {
      /* popup may be closed */
    });
  } catch {
    // No listener
  }
});

// ─── Message Handler ───────────────────────────────────────────

async function handleMessage(
  message: ExtensionMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  switch (message.type) {
    // ─── Queue operations ──────────────────────────────────

    case MSG.START_QUEUE: {
      const { articleName, prompts, hasRefImage } = message.payload as StartQueuePayload;
      try {
        const provider = await getActiveProvider();
        queueManager.setProvider(provider);
        
        const refImageKeys: (string | undefined)[] = [];
        if (hasRefImage) {
          for (let i = 0; i < prompts.length; i++) {
            if (hasRefImage[i]) {
              const uniqueKey = `ref-image-item-${crypto.randomUUID()}`;
              refImageKeys.push(uniqueKey);
              
              const tempKey = `ref-image-prompt-${i + 1}`;
              try {
                const tempImage = await imageStore.get(tempKey);
                if (tempImage) {
                  await imageStore.store(uniqueKey, tempImage.blob, undefined, undefined, tempImage.localFilename);
                  await imageStore.delete(tempKey);
                }
              } catch (err) {
                logger.warn('Failed to transfer temp prompt reference image', { index: i, error: String(err) });
              }
            } else {
              refImageKeys.push(undefined);
            }
          }
        }
        
        await queueManager.start(articleName, prompts, refImageKeys.length > 0 ? refImageKeys : undefined);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
      break;
    }

    case MSG.PAUSE_QUEUE: {
      await queueManager.pause();
      sendResponse({ success: true });
      break;
    }

    case MSG.RESUME_QUEUE: {
      await queueManager.resume();
      sendResponse({ success: true });
      break;
    }

    case MSG.CANCEL_QUEUE: {
      await queueManager.cancel();
      sendResponse({ success: true });
      break;
    }

    case MSG.RETRY_ITEM: {
      const { itemId } = message.payload as RetryItemPayload;
      await queueManager.retryItem(itemId);
      sendResponse({ success: true });
      break;
    }

    case MSG.REMOVE_ITEM: {
      const { itemId } = message.payload as RemoveItemPayload;
      await queueManager.removeItem(itemId);
      sendResponse({ success: true });
      break;
    }

    case MSG.SKIP_ITEM: {
      const { itemId } = message.payload as SkipItemPayload;
      await queueManager.skipItem(itemId);
      sendResponse({ success: true });
      break;
    }

    case MSG.GET_QUEUE_STATUS: {
      sendResponse(queueManager.getQueue());
      break;
    }

    case MSG.CLEAR_QUEUE: {
      await queueManager.clearQueue();
      await imageStore.clear();
      sendResponse({ success: true });
      break;
    }

    // ─── ChatGPT content script responses ──────────────────

    case MSG.IMAGE_GENERATED: {
      const payload = message.payload as ImageGeneratedPayload;
      logger.info('Image generated', { itemId: payload.itemId });
      chatgptProvider.handleImageGenerated(payload);
      geminiProvider.handleImageGenerated(payload);
      break;
    }

    case MSG.GENERATION_FAILED: {
      const payload = message.payload as GenerationFailedPayload;
      logger.error('Generation failed', {
        itemId: payload.itemId,
        error: payload.error,
      });
      chatgptProvider.handleGenerationFailed(payload);
      geminiProvider.handleGenerationFailed(payload);
      break;
    }

    case MSG.CONTENT_SCRIPT_READY: {
      logger.info('Content script ready');
      break;
    }

    // ─── Image processing ──────────────────────────────────

    case MSG.PROCESS_IMAGES: {
      const { options } = message.payload as ProcessImagesPayload;
      try {
        const result = await processAndZipImages(options);
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
      break;
    }

    case MSG.DOWNLOAD_ZIP: {
      const { options } = message.payload as { options: ProcessingOptions };
      try {
        const result = await downloadLatestZip(options);
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
      break;
    }

    case MSG.DOWNLOAD_INDIVIDUAL: {
      const { options } = message.payload as { options: ProcessingOptions };
      try {
        await downloadIndividualImages(options);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
      break;
    }

    // ─── ChatGPT & Gemini tabs ────────────────────────────

    case MSG.OPEN_CHATGPT: {
      const settings = await settingsStorage.load();
      const existing = await findChatGPTTab(settings.chatgptDomain);
      if (existing) {
        chrome.tabs.update(existing.id!, { active: true });
        sendResponse({ success: true, tabId: existing.id });
      } else {
        const tab = await openChatGPTTab(settings.chatgptDomain);
        sendResponse({ success: true, tabId: tab.id });
      }
      break;
    }

    case MSG.OPEN_GEMINI: {
      const settings = await settingsStorage.load();
      const existing = await findGeminiTab(settings.geminiDomain);
      if (existing) {
        chrome.tabs.update(existing.id!, { active: true });
        sendResponse({ success: true, tabId: existing.id });
      } else {
        const tab = await openGeminiTab(settings.geminiDomain);
        sendResponse({ success: true, tabId: tab.id });
      }
      break;
    }

    // ─── Diagnostics ──────────────────────────────────────

    case MSG.GET_DIAGNOSTICS: {
      const diagnostics = await getDiagnostics();
      sendResponse(diagnostics);
      break;
    }

    // ─── Settings ──────────────────────────────────────────

    case MSG.GET_SETTINGS: {
      const settings = await settingsStorage.load();
      sendResponse(settings);
      break;
    }

    case MSG.SAVE_SETTINGS: {
      const { settings } = message.payload as SaveSettingsPayload;
      await settingsStorage.save(settings);
      // Apply settings to queue manager
      queueManager.setMaxRetries(settings.maxRetries);
      queueManager.setGenerationTimeout(settings.generationTimeoutMs);
      queueManager.setPauseOnFailure(settings.pauseOnFailure);
      sendResponse({ success: true });
      break;
    }

    // ─── Logs ──────────────────────────────────────────────

    case MSG.GET_LOGS: {
      const logs = await logger.getAll();
      sendResponse(logs);
      break;
    }

    case MSG.CLEAR_LOGS: {
      await logger.clear();
      sendResponse({ success: true });
      break;
    }
  }
}

// ─── Image Processing & ZIP ────────────────────────────────────

let lastZipBlob: Blob | null = null;

async function processAndZipImages(
  options: ProcessingOptions
): Promise<{ success: boolean; error?: string; fileCount?: number }> {
  const queue = queueManager.getQueue();
  const completedItems = queue.items.filter((i) => i.status === 'completed');

  if (completedItems.length === 0) {
    return { success: false, error: 'No completed images to process' };
  }

  logger.info('Processing images', {
    count: completedItems.length,
    format: options.format,
    quality: options.quality,
    resolution: options.resolution,
  });

  try {
    // We need an offscreen document for Canvas-based image processing
    await ensureOffscreenDocument();

    // Send processing request to offscreen document
    const result = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PROCESS_IMAGES',
      payload: {
        items: completedItems.map((i) => ({ id: i.id, prompt: i.prompt })),
        options,
      },
    });

    if (result && (result as Record<string, unknown>).zipBlob) {
      lastZipBlob = (result as Record<string, Blob>).zipBlob;
      return { success: true, fileCount: completedItems.length };
    }

    return { success: false, error: 'Processing failed' };
  } catch (err) {
    logger.error('Image processing failed', { error: String(err) });
    return { success: false, error: String(err) };
  }
}

async function downloadLatestZip(options?: ProcessingOptions): Promise<{ success: boolean; error?: string }> {
  if (lastZipBlob && !options) {
    try {
      const url = URL.createObjectURL(lastZipBlob);
      const queue = queueManager.getQueue();
      await chrome.downloads.download({
        url,
        filename: `${queue.articleName || 'image'}-images.zip`,
        saveAs: true,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  try {
    await ensureOffscreenDocument();

    const queue = queueManager.getQueue();
    const completedItems = queue.items.filter((i) => i.status === 'completed');

    if (completedItems.length === 0) {
      return { success: false, error: 'No images to download' };
    }

    // Tell offscreen to build ZIP and return as blob URL
    const response = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_BUILD_ZIP',
      payload: {
        items: completedItems.map((i) => ({ id: i.id, prompt: i.prompt })),
        options,
      },
    }) as { blobUrl?: string; filename?: string } | undefined;

    if (response?.blobUrl) {
      await chrome.downloads.download({
        url: response.blobUrl,
        filename: response.filename || `${options?.filenamePrefix || queue.articleName || 'image'}-images.zip`,
        saveAs: true,
      });
      return { success: true };
    }

    return { success: false, error: 'Failed to create ZIP' };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function downloadIndividualImages(options: ProcessingOptions): Promise<void> {
  const queue = queueManager.getQueue();
  const completedItems = queue.items.filter((i) => i.status === 'completed');

  await ensureOffscreenDocument();

  for (let i = 0; i < completedItems.length; i++) {
    const item = completedItems[i];
    
    // Choose custom name if specified, otherwise index-based
    let customName = '';
    if (options.customFilenames && options.customFilenames[item.id]) {
      customName = options.customFilenames[item.id];
    } else {
      const prefix = options.filenamePrefix || 'image';
      customName = `${prefix}-${String(i + 1).padStart(2, '0')}`;
    }

    const itemOptions = {
      ...options,
      customFilenames: {
        [item.id]: customName
      }
    };

    const response = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PROCESS_SINGLE_IMAGE',
      payload: {
        itemId: item.id,
        options: itemOptions,
        prompt: item.prompt,
      },
    }) as { blobUrl?: string; filename?: string; error?: string } | undefined;

    if (response?.error) {
      throw new Error(response.error);
    }

    if (response?.blobUrl) {
      await chrome.downloads.download({
        url: response.blobUrl,
        filename: response.filename!,
        saveAs: false,
      });
    }
  }
}

function getExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
  };
  return map[mimeType] || 'png';
}

// ─── Offscreen Document ────────────────────────────────────────

let offscreenCreating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  // Check if we already have one
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (existingContexts.length > 0) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['BLOBS' as chrome.offscreen.Reason],
    justification: 'Image format conversion and ZIP creation using Canvas API',
  });

  await offscreenCreating;
  offscreenCreating = null;
}

// ─── Diagnostics ───────────────────────────────────────────────

async function getDiagnostics(): Promise<DiagnosticsInfo> {
  const settings = await settingsStorage.load();
  let providerReady = false;
  let tabDetected = false;

  if (settings.activeProvider === 'gemini') {
    const tab = await findGeminiTab(settings.geminiDomain);
    tabDetected = !!tab;
    if (tab?.id) {
      try {
        const status = await checkGeminiStatus(tab.id);
        providerReady = status.ready;
      } catch {
        // Not reachable
      }
    }
  } else {
    const tab = await findChatGPTTab(settings.chatgptDomain);
    tabDetected = !!tab;
    if (tab?.id) {
      try {
        const status = await checkChatGPTStatus(tab.id);
        providerReady = status.ready;
      } catch {
        // Not reachable
      }
    }
  }

  let downloadsOk = true;
  try {
    // Check downloads permission
    const perms = await chrome.permissions.contains({
      permissions: ['downloads'],
    });
    downloadsOk = perms;
  } catch {
    downloadsOk = false;
  }

  const usage = await imageStore.getUsage();

  return {
    chatgptTabDetected: tabDetected,
    chatgptReady: providerReady,
    queueWorkerRunning: queueManager.getState() === 'running',
    downloadsPermission: downloadsOk,
    storageUsedBytes: usage,
  };
}

// ─── Event Listeners ───────────────────────────────────────────

// Message handler
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    // Handle async messages
    handleMessage(message, sender, sendResponse);
    return true; // Keep message channel open for async responses
  }
);

// Keepalive port listener
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'chatgpt-keepalive') {
    port.onMessage.addListener((msg) => {
      // Keepalive received — service worker stays active
      if (msg.type === MSG.KEEPALIVE) {
        // No-op, the port connection itself keeps the SW alive
      }
    });
  }
});

// Recovery alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === QUEUE_RECOVERY_ALARM) {
    const state = queueManager.getState();
    if (state === 'running' && !queueManager.isProcessing()) {
      logger.info('Recovery alarm: resuming stalled queue');
      await queueManager.restore();
    }
  }
});

// ─── Auto-Switch Provider on Tab Switch ─────────────────────────

async function autoSwitchProvider(tabId: number, url?: string): Promise<void> {
  if (!url) {
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab.url;
    } catch {
      return;
    }
  }
  if (!url) return;

  const settings = await settingsStorage.load();
  let changed = false;

  if (url.includes('chatgpt.com') && settings.activeProvider !== 'chatgpt') {
    settings.activeProvider = 'chatgpt';
    changed = true;
    logger.info('Auto-switched active provider to ChatGPT based on tab focus');
  } else if (url.includes('gemini.google.com') && settings.activeProvider !== 'gemini') {
    settings.activeProvider = 'gemini';
    changed = true;
    logger.info('Auto-switched active provider to Gemini based on tab focus');
  }

  if (changed) {
    await settingsStorage.save(settings);
    queueManager.setProvider(settings.activeProvider === 'gemini' ? geminiProvider : chatgptProvider);
    
    // Broadcast setting change
    chrome.runtime.sendMessage({
      type: MSG.QUEUE_STATUS_UPDATE,
      payload: queueManager.getQueue(),
    }).catch(() => {});
  }
}

// Listen for active tab changes
chrome.tabs.onActivated.addListener((activeInfo) => {
  autoSwitchProvider(activeInfo.tabId).catch((err) => {
    logger.debug('Error in tabs.onActivated autoSwitchProvider', { error: String(err) });
  });
});

// Listen for tab URL updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    autoSwitchProvider(tabId, tab.url).catch((err) => {
      logger.debug('Error in tabs.onUpdated autoSwitchProvider', { error: String(err) });
    });
  }
});

// ─── Initialization ────────────────────────────────────────────

async function initialize(): Promise<void> {
  logger.debug('Service worker starting');

  // Load settings and configure queue manager
  const settings = await settingsStorage.load();
  queueManager.setMaxRetries(settings.maxRetries);
  queueManager.setGenerationTimeout(settings.generationTimeoutMs);
  queueManager.setPauseOnFailure(settings.pauseOnFailure);

  // Restore queue state
  await queueManager.restore();

  // Set up recovery alarm
  chrome.alarms.create(QUEUE_RECOVERY_ALARM, {
    periodInMinutes: QUEUE_RECOVERY_INTERVAL_MIN,
  });

  // Check currently active tab on startup
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      await autoSwitchProvider(tabs[0].id, tabs[0].url);
    }
  } catch (err) {
    logger.debug('Failed to check active tab on startup', { error: String(err) });
  }

  logger.debug('Service worker initialized');
}

// Run initialization
initialize().catch((err) => {
  logger.error('Service worker initialization failed', { error: String(err) });
});
