import {
  IMAGE_SELECTORS,
  NEW_CHAT_SELECTORS,
  queryFirst,
  queryAll,
} from './gemini-selectors';
import {
  isReady,
  isGenerating,
  getComposer,
  getSendButton,
  getAssistantMessageCount,
  getLastAssistantMessage,
  getLimitError,
} from './gemini-detector';
import { MUTATION_OBSERVER_TIMEOUT_MS } from '../shared/constants';
import { logger } from '../shared/logger';

/**
 * Gemini DOM adapter — performs all direct DOM interaction.
 */

export interface AdapterResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

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

export function startNewConversation(): boolean {
  const newChatBtn = queryFirst(NEW_CHAT_SELECTORS);
  if (newChatBtn) {
    (newChatBtn as HTMLElement).click();
    return true;
  }
  window.location.href = '/app';
  return true;
}

export function waitForImage(
  startMessageCount: number,
  timeoutMs: number = MUTATION_OBSERVER_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let observer: MutationObserver | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let hasStartedGenerating = false;
    let checkAttemptsAfterStop = 0;
    const startTime = Date.now();

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
      const limitError = getLimitError();
      if (limitError) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Usage Limit Reached: ${limitError}`));
        return true;
      }

      const generating = isGenerating();
      if (generating || (Date.now() - startTime > 4000)) {
        hasStartedGenerating = true;
      }

      const currentCount = getAssistantMessageCount();
      if (currentCount <= startMessageCount) {
        return false;
      }

      if (!lastMessageAppearTime) {
        lastMessageAppearTime = Date.now();
        return false;
      }

      // Grace period: allow loading indicator block to mount in background tabs
      if (Date.now() - lastMessageAppearTime < 6000) {
        return false;
      }

      // If we haven't seen the generating state yet, keep waiting
      if (!hasStartedGenerating) {
        return false;
      }

      if (generating) {
        return false;
      }

      const lastMsg = getLastAssistantMessage();
      if (!lastMsg) {
        return false;
      }

      const imageUrl = extractBestImageUrl(lastMsg);
      if (imageUrl) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        resolve(imageUrl);
        return true;
      }

      if (isStillCreating(lastMsg) || hasPotentialImage(lastMsg)) {
        return false;
      }

      // If the composer is still disabled or Gemini is still working, keep waiting
      if (!isReady()) {
        return false;
      }

      // Let the DOM settle briefly after generating stops to ensure image URL or error text is fully loaded
      if (checkAttemptsAfterStop < 3) {
        checkAttemptsAfterStop++;
        return false;
      }

      const text = lastMsg.textContent?.trim() || 'No image generated';
      if (text.length < 15) {
        return false;
      }

      resolved = true;
      clearTimeout(timeout);
      cleanup();
      reject(new Error(text));
      return true;
    };

    if (checkForImage()) return;

    observer = new MutationObserver(() => {
      if (resolved) return;
      checkForImage();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'class'],
    });

    // POLLING FALLBACK: Chrome throttles MutationObserver in background tabs.
    // Poll every 2s to ensure we catch the generated image even when tab is inactive.
    pollInterval = setInterval(() => {
      if (resolved) return;
      checkForImage();
    }, 2000);
  });
}

function extractBestImageUrl(messageElement: Element): string | null {
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

  // STRATEGY 2 (FALLBACK): Search the entire document from bottom to top for the latest generated image.
  logger.info('Gemini scoped message search failed. Running document-wide chronological search fallback.');

  const allDocImgs = Array.from(document.querySelectorAll('img'));
  for (let i = allDocImgs.length - 1; i >= 0; i--) {
    const img = allDocImgs[i];
    const src = img.src || '';
    if (src.includes('avatar') || src.includes('profile') || src.includes('icon')) continue;
    if (img.closest('[class*="avatar"]') || img.closest('[class*="profile"]')) continue;

    const candidates = [
      img.src,
      img.getAttribute('data-src'),
      img.getAttribute('srcset'),
      img.getAttribute('data-original-src'),
      img.getAttribute('data-image-src')
    ];
    for (const rawSrc of candidates) {
      if (rawSrc) {
        const cleanSrc = parseSrcset(rawSrc);
        if (cleanSrc && isImageUrl(cleanSrc)) {
          logger.info('Found Gemini generated image via document-wide img search', { url: cleanSrc.slice(0, 80) });
          return cleanSrc;
        }
      }
    }
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

function hasPotentialImage(messageElement: Element): boolean {
  const images = messageElement.querySelectorAll('img');
  for (const img of images) {
    if (img instanceof HTMLImageElement) {
      const src = img.src || '';
      if (src.includes('avatar') || src.includes('profile') || src.includes('icon')) continue;
      return true;
    }
  }
  return false;
}

function isStillCreating(messageElement: Element): boolean {
  const text = messageElement.textContent?.toLowerCase() || '';
  const statusKeywords = [
    'generating',
    'creating',
    'drawing',
    'working',
    'defining',
    'composition',
    'refining',
    'detailed',
    'elements',
    'thinking',
    'analyzing',
  ];
  if (statusKeywords.some(kw => text.includes(kw))) {
    return true;
  }

  // Also check for any common loading/progress element tags or classes inside the message
  const loaderSelectors = [
    'mat-progress-spinner',
    '.progress-spinner',
    '.loading-indicator',
    '.spark-loader',
    '.thinking',
    '.dots',
    '.generating',
    'mat-spinner',
    '[role="progressbar"]',
  ];
  for (const selector of loaderSelectors) {
    if (messageElement.querySelector(selector)) {
      return true;
    }
  }

  return false;
}

function isImageUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('data:image/')) return true;
  if (url.includes('googleusercontent.com')) return true;
  if (url.includes('google.com/img')) return true;
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  return imageExtensions.some((ext) => url.toLowerCase().includes(ext));
}

export async function generateImage(
  prompt: string,
  newConversation: boolean = true,
  timeoutMs: number = MUTATION_OBSERVER_TIMEOUT_MS
): Promise<AdapterResult> {
  try {
    if (newConversation) {
      startNewConversation();
      await new Promise(r => setTimeout(r, 2000));
    }

    let ready = false;
    for (let i = 0; i < 120; i++) {
      const limitError = getLimitError();
      if (limitError) {
        return { success: false, error: `Usage Limit Reached: ${limitError}` };
      }
      if (isReady()) {
        ready = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) {
      return { success: false, error: 'Gemini not ready' };
    }

    insertPrompt(prompt);
    await new Promise(r => setTimeout(r, 500));

    const startCount = getAssistantMessageCount();
    submitPrompt();

    const imageUrl = await waitForImage(startCount, timeoutMs);
    return { success: true, imageUrl };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
