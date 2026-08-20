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
let activeGeneratingItemId: string | null = null;

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
  activeGeneratingItemId = itemId;

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
    activeGeneratingItemId = null;
    stopKeepalive();
  }
}

/** Programmatically upload a reference image to the composer */
async function uploadReferenceImage(dataUrl: string): Promise<void> {
  // Helper to determine if an input is a feedback/help/support element on Google domains
  function isFeedbackInput(el: HTMLInputElement): boolean {
    const id = (el.id || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    return id.includes('feedback') || cls.includes('feedback') || name.includes('feedback') || ariaLabel.includes('feedback') ||
           id.includes('help') || cls.includes('help') || ariaLabel.includes('help') ||
           id.includes('support') || cls.includes('support') || ariaLabel.includes('support') ||
           id.includes('bug') || cls.includes('bug') || ariaLabel.includes('bug');
  }

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

    // Also check if the root element itself has a shadowRoot
    if ('shadowRoot' in root && root.shadowRoot) {
      const found = findFileInput(root.shadowRoot);
      if (found) return found;
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
  const isGoogle = window.location.hostname.includes('google.com');

  // 1. If on Google/Gemini, try to locate the file input inside rich-textarea shadow root first
  if (isGoogle) {
    try {
      const richTextarea = document.querySelector('rich-textarea');
      if (richTextarea && richTextarea.shadowRoot) {
        fileInput = richTextarea.shadowRoot.querySelector('input[type="file"]') as HTMLInputElement;
        if (!fileInput) {
          fileInput = richTextarea.shadowRoot.querySelector('input[accept*="image"]') as HTMLInputElement;
        }
      }

      if (!fileInput) {
        const composerArea = document.querySelector('.input-area-container') ||
                             document.querySelector('.input-area') ||
                             document.querySelector('.text-area') ||
                             document.querySelector('rich-textarea')?.parentElement;
        if (composerArea) {
          fileInput = composerArea.querySelector('input[type="file"]') as HTMLInputElement;
          if (!fileInput) {
            fileInput = composerArea.querySelector('input[accept*="image"]') as HTMLInputElement;
          }
        }
      }
    } catch (err) {
      console.warn('[Image Queue] Error searching Gemini-specific selectors:', err);
    }
  }

  // 2. Try search closest to composer first
  if (!fileInput) {
    const composerEl = document.querySelector('.ql-editor[contenteditable="true"]') || 
                       document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                       document.querySelector('rich-textarea') ||
                       document.querySelector('textarea');
                       
    if (composerEl) {
      let curr: Element | null = composerEl;
      for (let depth = 0; depth < 6 && curr; depth++) {
        const found = findFileInput(curr);
        if (found && (!isGoogle || !isFeedbackInput(found))) {
          fileInput = found;
          break;
        }
        curr = curr.parentElement;
      }
    }
  }

  // 3. Fall back to entire document
  if (!fileInput) {
    const found = findFileInput(document);
    if (found && (!isGoogle || !isFeedbackInput(found))) {
      fileInput = found;
    } else if (isGoogle) {
      // If we are on Google and matched a feedback input, retrieve all and filter out feedback inputs
      const allInputs = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
      const correctInput = allInputs.find(input => !isFeedbackInput(input));
      if (correctInput) {
        fileInput = correctInput;
      }
    }
  }

  if (!fileInput) {
    throw new Error('File input element not found in DOM or Shadow DOM');
  }

  console.log('[Image Queue] Selected file input for upload:', {
    tagName: fileInput.tagName,
    id: fileInput.id,
    className: fileInput.className,
    accept: fileInput.getAttribute('accept'),
    outerHTML: fileInput.outerHTML
  });

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
      sendResponse({
        pong: true,
        ready: detector.isReady(),
        activeGeneratingItemId
      });
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
