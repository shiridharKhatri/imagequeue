import {
  MSG,
  type ExtensionMessage,
  type GenerateImagePayload,
} from '../shared/messages';
import type { ChatGPTStatus } from '../shared/types';
import * as chatgptDetector from './chatgpt-detector';
import * as chatgptAdapter from './chatgpt-adapter';
import * as geminiDetector from './gemini-detector';
import * as geminiAdapter from './gemini-adapter';
import { KEEPALIVE_INTERVAL_MS } from '../shared/constants';

const isGemini = window.location.hostname.includes('gemini.google.com');
const detector = isGemini ? geminiDetector : chatgptDetector;
const adapter = isGemini ? geminiAdapter : chatgptAdapter;

/**
 * Content script entry point — injected into ChatGPT pages.
 *
 * Responsibilities:
 * 1. Listen for messages from the service worker
 * 2. Dispatch to the ChatGPT adapter
 * 3. Maintain a keepalive port during generation
 * 4. Report results back to the service worker
 */

let keepalivePort: chrome.runtime.Port | null = null;
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

/** Announce that the content script is loaded and ready */
function announceReady(): void {
  try {
    chrome.runtime.sendMessage({
      type: MSG.CONTENT_SCRIPT_READY,
      payload: { url: window.location.href },
    }).catch(() => { /* service worker may not be listening yet */ });
  } catch {
    // Extension context may not be available
  }
}

/** Start a keepalive port to prevent service worker from sleeping during generation */
function startKeepalive(): void {
  stopKeepalive();

  try {
    keepalivePort = chrome.runtime.connect({ name: 'chatgpt-keepalive' });
    keepalivePort.onDisconnect.addListener(() => {
      keepalivePort = null;
    });

    keepaliveInterval = setInterval(() => {
      if (keepalivePort) {
        keepalivePort.postMessage({ type: MSG.KEEPALIVE });
      }
    }, KEEPALIVE_INTERVAL_MS);
  } catch {
    // Extension context invalidated
  }
}

/** Stop the keepalive port */
function stopKeepalive(): void {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
  if (keepalivePort) {
    try {
      keepalivePort.disconnect();
    } catch {
      // Already disconnected
    }
    keepalivePort = null;
  }
}

/** Handle status check from service worker */
function handleCheckStatus(): ChatGPTStatus {
  return {
    tabFound: true,
    loggedIn: detector.isLoggedIn(),
    ready: detector.isReady(),
    composerFound: !!detector.getComposer(),
  };
}

/** Handle image generation request */
async function handleGenerateImage(
  payload: GenerateImagePayload
): Promise<void> {
  const { itemId, prompt, newConversation, refImageDataUrl } = payload;

  // Start keepalive to prevent service worker from sleeping
  startKeepalive();

  try {
    if (refImageDataUrl) {
      try {
        await uploadReferenceImage(refImageDataUrl);
        // Wait a brief moment for Gemini/ChatGPT to process the file upload
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (err) {
        console.error('[Image Queue] Reference image upload failed, proceeding with prompt only:', err);
      }
    }

    const result = await adapter.generateImage(prompt, newConversation);

    if (result.success && result.imageUrl) {
      // Notify service worker of success
      chrome.runtime.sendMessage({
        type: MSG.IMAGE_GENERATED,
        payload: {
          itemId,
          imageUrl: result.imageUrl,
        },
      }).catch(console.error);
    } else {
      // Notify service worker of failure
      chrome.runtime.sendMessage({
        type: MSG.GENERATION_FAILED,
        payload: {
          itemId,
          error: result.error || 'Unknown generation error',
        },
      }).catch(console.error);
    }
  } catch (err) {
    chrome.runtime.sendMessage({
      type: MSG.GENERATION_FAILED,
      payload: {
        itemId,
        error: err instanceof Error ? err.message : String(err),
      },
    }).catch(console.error);
  } finally {
    stopKeepalive();
  }
}

/** Programmatically upload a reference image to the composer */
async function uploadReferenceImage(dataUrl: string): Promise<void> {
  // Helper to recursively find file inputs in light DOM or shadow DOM
  function findFileInput(root: Document | Element | ShadowRoot): HTMLInputElement | null {
    try {
      const direct = root.querySelector('input[type="file"]');
      if (direct) return direct as HTMLInputElement;

      const accept = root.querySelector('input[accept*="image"]');
      if (accept) return accept as HTMLInputElement;
    } catch {
      // ignore selector errors
    }

    let children: Element[] = [];
    try {
      children = Array.from(root.querySelectorAll('*'));
    } catch {
      // ignore query errors
    }

    for (const child of children) {
      if (child.shadowRoot) {
        const found = findFileInput(child.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  let fileInput: HTMLInputElement | null = null;

  // 1. Try search closest to composer first
  const composerEl = document.querySelector('.ql-editor[contenteditable="true"]') || 
                     document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                     document.querySelector('rich-textarea') ||
                     document.querySelector('textarea');
                     
  if (composerEl) {
    let curr: Element | null = composerEl;
    for (let depth = 0; depth < 6 && curr; depth++) {
      fileInput = findFileInput(curr);
      if (fileInput) break;
      curr = curr.parentElement;
    }
  }

  // 2. Fall back to entire document
  if (!fileInput) {
    fileInput = findFileInput(document);
  }

  if (!fileInput) {
    throw new Error('File input element not found in DOM or Shadow DOM');
  }

  // Fetch the data URL and convert to blob
  const res = await fetch(dataUrl);
  const blob = await res.blob();

  // Create a File object
  const file = new File([blob], 'product-reference.jpg', { type: blob.type || 'image/jpeg' });

  // Use DataTransfer to construct a FileList
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  fileInput.files = dataTransfer.files;

  // Dispatch change and input events with bubbles & composed to cross shadow DOM boundaries
  fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}

/** Message listener */
function onMessage(
  message: ExtensionMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): boolean {
  switch (message.type) {
    case MSG.CHECK_CHATGPT: {
      const status = handleCheckStatus();
      sendResponse(status);
      return false; // synchronous
    }

    case MSG.GENERATE_IMAGE: {
      const payload = message.payload as GenerateImagePayload;
      // Async handling — must return true
      handleGenerateImage(payload);
      sendResponse({ received: true });
      return false;
    }

    case MSG.CHECK_GEMINI: {
      const status = handleCheckStatus();
      sendResponse(status);
      return false; // synchronous
    }

    case MSG.PING: {
      sendResponse({ pong: true, ready: detector.isReady() });
      return false;
    }

    default:
      return false;
  }
}

// ─── Initialization ────────────────────────────────────────────

// Register message listener
chrome.runtime.onMessage.addListener(onMessage);

// Announce readiness
announceReady();

console.log('[Image Queue] Content script loaded on', window.location.href);
