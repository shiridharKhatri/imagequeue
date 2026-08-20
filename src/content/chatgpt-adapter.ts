import {
  IMAGE_SELECTORS,
  IMAGE_DOWNLOAD_SELECTORS,
  NEW_CHAT_SELECTORS,
  queryFirst,
  queryAll,
} from './chatgpt-selectors';
import {
  isReady,
  isGenerating,
  getComposer,
  getSendButton,
  getAssistantMessageCount,
  getLastAssistantMessage,
  getLimitError,
} from './chatgpt-detector';
import { MUTATION_OBSERVER_TIMEOUT_MS } from '../shared/constants';
import { logger } from '../shared/logger';

/**
 * ChatGPT DOM adapter — performs all direct DOM interaction.
 *
 * This module:
 * - Inserts prompts into the composer
 * - Submits prompts
 * - Watches for image generation completion via MutationObserver
 * - Extracts the highest-quality image URL
 *
 * It does NOT contain any queue logic.
 */

export interface AdapterResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

/**
 * Insert text into the ChatGPT composer.
 *
 * ChatGPT uses a contenteditable div (ProseMirror), so we can't just set .value.
 * We use execCommand('insertText') which triggers React's internal event handling.
 */
export function insertPrompt(text: string): boolean {
  const composer = getComposer();
  if (!composer) return false;

  const el = composer as HTMLElement;

  // Focus the composer
  el.focus();

  // Try execCommand first (works if tab has focus)
  try {
    document.execCommand('selectAll', false, undefined);
    document.execCommand('delete', false, undefined);
    document.execCommand('insertText', false, text);
  } catch (e) {
    // ignore
  }

  // Double check if text got set. If not (background tab), manually set it and dispatch synthetic events
  const currentText = el.getAttribute('contenteditable') === 'true' ? el.textContent : (el as HTMLTextAreaElement).value;
  if (!currentText || currentText.trim() !== text.trim()) {
    if (el.getAttribute('contenteditable') === 'true') {
      // Clear first
      el.innerHTML = '';
      
      // Create a text node (ProseMirror likes text nodes inside paragraphs)
      const p = document.createElement('p');
      p.appendChild(document.createTextNode(text));
      el.appendChild(p);
    } else {
      (el as HTMLTextAreaElement).value = text;
    }
  }

  // Dispatch beforeinput and input events to force React/ProseMirror to sync state
  try {
    const beforeInputEvent = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    });
    el.dispatchEvent(beforeInputEvent);

    const inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    });
    el.dispatchEvent(inputEvent);

    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    // ignore
  }

  return true;
}

/**
 * Click the send button to submit the prompt.
 */
export function submitPrompt(): boolean {
  const sendBtn = getSendButton();
  const composer = getComposer();

  const isDisabled = sendBtn ? (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') : true;

  if (sendBtn && !isDisabled) {
    try {
      sendBtn.click();
      return true;
    } catch (e) {
      // ignore
    }
  }

  // Dispatch Enter key events on the composer as fallback submit mechanism
  if (composer) {
    try {
      const enterDown = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      composer.dispatchEvent(enterDown);

      const enterPress = new KeyboardEvent('keypress', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      composer.dispatchEvent(enterPress);

      const enterUp = new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      composer.dispatchEvent(enterUp);
      return true;
    } catch (e) {
      // ignore
    }
  }

  return false;
}

/**
 * Navigate to a new ChatGPT conversation.
 */
export function startNewConversation(): boolean {
  const newChatBtn = queryFirst(NEW_CHAT_SELECTORS);
  if (newChatBtn) {
    (newChatBtn as HTMLElement).click();
    return true;
  }

  // Fallback: navigate directly
  window.location.href = '/';
  return true;
}

/**
 * Wait for ChatGPT to finish generating and produce an image.
 * Uses MutationObserver to avoid timer throttling in background tabs.
 *
 * Returns the image URL or throws on timeout/failure.
 */
export function waitForImage(
  startMessageCount: number,
  timeoutMs: number = MUTATION_OBSERVER_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let observer: MutationObserver | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      observer?.disconnect();
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    };

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error('Image generation timed out'));
    }, timeoutMs);

    let lastMessageAppearTime: number | null = null;

    const checkForImage = (): boolean => {
      // Check for rate/usage limit warnings immediately
      const limitError = getLimitError();
      if (limitError) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Usage Limit Reached: ${limitError}`));
        return true;
      }

      // First, wait for a new assistant message to appear
      const currentCount = getAssistantMessageCount();
      if (currentCount <= startMessageCount) {
        return false;
      }

      if (!lastMessageAppearTime) {
        lastMessageAppearTime = Date.now();
        return false;
      }

      // Grace period: allow DALL-E block to mount in background tabs
      if (Date.now() - lastMessageAppearTime < 6000) {
        return false;
      }

      // Check if generation is still in progress
      if (isGenerating()) {
        return false;
      }

      // Look for images in the last assistant message
      const lastMsg = getLastAssistantMessage();
      if (!lastMsg) {
        return false;
      }

      const imageUrl = extractBestImageUrl(lastMsg);
      if (imageUrl) {
        logger.info('Successfully detected generated image', { url: imageUrl.slice(0, 80) });
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        resolve(imageUrl);
        return true;
      }

      // If ChatGPT is still generating/creating the image, or there's a potential DALL-E image mounting, keep waiting
      if (isStillCreating(lastMsg) || hasPotentialDalleImage(lastMsg)) {
        return false;
      }

      // If the composer is still disabled or DALL-E is still working, keep waiting
      if (!isReady()) {
        return false;
      }

      // Since there's no active image loading or image element present, and we haven't found a valid URL,
      // it means ChatGPT finished and returned text, a policy block, or an error.
      const text = lastMsg.textContent?.trim() || 'No image generated';

      // Log DOM outerHTML for diagnostics
      logger.info('Diagnostic: No image element matched. Assistant message DOM structure:', {
        html: lastMsg.outerHTML.slice(0, 10000),
        text
      });

      // If the text is just "Edit" or very short, the image is likely still mounting in the DOM.
      // We return false to keep waiting instead of failing prematurely.
      if (text === 'Edit' || text.toLowerCase().includes('edit') || text.length < 15) {
        return false;
      }

      resolved = true;
      clearTimeout(timeout);
      cleanup();

      const errorText = text.length > 200 ? text.slice(0, 200) + '…' : text;
      logger.warn('ChatGPT returned text/error instead of image', { error: errorText });
      reject(new Error(errorText));
      return true;

      return false;
    };

    // Check immediately (in case generation already completed)
    if (checkForImage()) return;

    // Watch the entire body to survive React layout and route transitions
    const container = document.body;

    observer = new MutationObserver(() => {
      if (resolved) return;
      checkForImage();
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'class'],
    });

    // POLLING FALLBACK: Chrome heavily throttles MutationObserver in background/inactive tabs.
    // This polling interval ensures we still check for the generated image when the user
    // switches to a different tab during generation.
    pollInterval = setInterval(() => {
      if (resolved) return;
      checkForImage();
    }, 2000);
  });
}

export function waitForReady(timeoutMs: number = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const limitError = getLimitError();
    if (limitError) {
      reject(new Error(`Usage Limit Reached: ${limitError}`));
      return;
    }

    if (isReady()) {
      resolve();
      return;
    }

    let resolved = false;
    let observer: MutationObserver | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      observer?.disconnect();
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    };

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error('ChatGPT not ready within timeout'));
    }, timeoutMs);

    const checkReady = () => {
      const limit = getLimitError();
      if (limit) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Usage Limit Reached: ${limit}`));
        return;
      }

      if (isReady()) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        resolve();
      }
    };

    observer = new MutationObserver(() => {
      if (resolved) return;
      checkReady();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    // POLLING FALLBACK: Poll every 1s to handle tab freezing/throttling
    pollInterval = setInterval(() => {
      if (resolved) return;
      checkReady();
    }, 1000);
  });
}

function extractBestImageUrl(messageElement: Element): string | null {
  // Strategy 1: Look for a download link with direct image URL
  const downloadLink = queryFirst(IMAGE_DOWNLOAD_SELECTORS, messageElement);
  if (downloadLink && downloadLink instanceof HTMLAnchorElement) {
    const href = downloadLink.href;
    if (href && isImageUrl(href)) return href;
  }

  // Strategy 2: Find img elements matching our selectors
  const images = queryAll(IMAGE_SELECTORS, messageElement);
  for (const img of images) {
    if (img instanceof HTMLImageElement) {
      const candidates = [
        img.src,
        img.getAttribute('data-src'),
        img.getAttribute('srcset'),
        img.getAttribute('data-original-src'),
        img.getAttribute('data-image-src')
      ];
      for (const src of candidates) {
        if (src) {
          const cleanSrc = parseSrcset(src);
          if (cleanSrc && isImageUrl(cleanSrc)) return cleanSrc;
        }
      }
    }
  }

  // Strategy 3: Broader search — any img with a substantial src
  const allImgs = messageElement.querySelectorAll('img');
  for (const img of allImgs) {
    if (img instanceof HTMLImageElement) {
      const candidates = [
        img.src,
        img.getAttribute('data-src'),
        img.getAttribute('srcset'),
        img.getAttribute('data-original-src'),
        img.getAttribute('data-image-src')
      ];
      for (const src of candidates) {
        if (src) {
          if (src.startsWith('data:') && src.length < 1000) continue;
          if (src.includes('avatar') || src.includes('profile') || src.includes('icon')) continue;
          const cleanSrc = parseSrcset(src);
          if (cleanSrc && isImageUrl(cleanSrc)) return cleanSrc;
        }
      }
    }
  }

  // Diagnostics: if we found images but none matched, log their src attributes!
  if (allImgs.length > 0) {
    const srcs = Array.from(allImgs).map(img => (img as HTMLImageElement).src || 'no-src');
    logger.info('Found image elements but none matched filters', { count: allImgs.length, srcs });
  }

  return null;
}

function parseSrcset(srcset: string): string {
  if (!srcset) return '';
  if (!srcset.includes(' ')) return srcset.trim();
  const parts = srcset.split(',');
  const lastPart = parts[parts.length - 1].trim();
  const urlAndWidth = lastPart.split(/\s+/);
  return urlAndWidth[0].trim();
}

/**
 * Check if the assistant message contains a potential DALL-E generated image (filtering out avatar/icons).
 */
function hasPotentialDalleImage(messageElement: Element): boolean {
  const images = messageElement.querySelectorAll('img');
  for (const img of images) {
    if (img instanceof HTMLImageElement) {
      const src = img.src || '';
      // Skip obvious avatars/icons
      if (src.includes('avatar') || src.includes('profile') || src.includes('icon')) continue;
      
      // Check if it's inside an avatar or profile container
      if (img.closest('[class*="avatar"]') || img.closest('[class*="profile"]')) continue;
      
      // Found any image element that is NOT an avatar/icon
      return true;
    }
  }
  return false;
}

/**
 * Check if the assistant message is still actively generating/loading an image.
 */
function isStillCreating(messageElement: Element): boolean {
  const text = messageElement.textContent?.toLowerCase() || '';
  
  // Check for common generation keywords in text
  const statusKeywords = [
    'creating image',
    'creating...',
    'generating image',
    'rendering image',
    'analyzing...',
    'working on it',
    'sketching',
    'sketching it out',
    'dall-e',
    'generating',
    'drawing',
    'working',
    'which image do you',
    'like more',
  ];
  if (statusKeywords.some(kw => text.includes(kw))) {
    return true;
  }

  // Check for progress bars, skeletons, spin icons, or DALL-E blocks
  const selectors = [
    '[class*="loading"]',
    '[class*="spinner"]',
    '[class*="progress"]',
    '[class*="skeleton"]',
    '[class*="dalle"]',
    '[class*="estuary"]',
    '.animate-spin',
    'svg.animate-spin',
  ];
  for (const sel of selectors) {
    if (messageElement.querySelector(sel)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a URL appears to be a valid image URL.
 */
function isImageUrl(url: string): boolean {
  if (!url) return false;

  // Data URLs (base64 images)
  if (url.startsWith('data:image/')) return true;

  // Known ChatGPT image hosts
  if (url.includes('oaiusercontent.com')) return true;
  if (url.includes('dalle')) return true;
  if (url.includes('/backend-api/estuary/content')) return true;
  if (url.includes('/backend-api/files/')) return true;
  if (url.includes('/backend-api/')) return true;

  // Common image extensions
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
  const urlLower = url.toLowerCase();
  if (imageExtensions.some((ext) => urlLower.includes(ext))) return true;

  // Blob URLs
  if (url.startsWith('blob:')) return true;

  return false;
}

/**
 * Perform a complete image generation cycle:
 * 1. Optionally start a new conversation
 * 2. Wait for ready state
 * 3. Insert prompt
 * 4. Submit
 * 5. Wait for image
 * 6. Return URL
 */
export async function generateImage(
  prompt: string,
  newConversation: boolean = true,
  timeoutMs: number = MUTATION_OBSERVER_TIMEOUT_MS
): Promise<AdapterResult> {
  try {
    logger.info('Starting image generation cycle', { prompt: logger.truncatePrompt(prompt), newConversation });

    // Step 1: New conversation (if requested)
    if (newConversation) {
      logger.info('Starting new conversation');
      startNewConversation();
      // Wait for the page to settle
      await delay(2000);
    }

    // Step 2: Wait for ChatGPT to be ready
    logger.info('Waiting for ChatGPT composer and page ready');
    await waitForReady(60_000);

    // Step 3: Insert the prompt
    logger.info('Inserting prompt into composer');
    const inserted = insertPrompt(prompt);
    if (!inserted) {
      logger.error('Failed to find composer textarea');
      return { success: false, error: 'Could not find message composer' };
    }

    // Small delay for React to process
    await delay(500);

    // Capture message count BEFORE submitting
    const startMessageCount = getAssistantMessageCount();
    logger.info('Captured initial assistant message count', { startMessageCount });

    // Step 4: Submit
    logger.info('Submitting prompt');
    const submitted = submitPrompt();
    if (!submitted) {
      logger.error('Failed to locate or click submit button');
      return { success: false, error: 'Could not find or click send button' };
    }

    // Step 5: Wait for the image
    logger.info('Waiting for image generation completion...');
    const imageUrl = await waitForImage(startMessageCount, timeoutMs);

    return { success: true, imageUrl };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Adapter image generation failed', { error: errorMsg });
    return { success: false, error: errorMsg };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
