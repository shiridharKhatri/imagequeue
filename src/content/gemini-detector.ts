import {
  COMPOSER_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STREAMING_INDICATORS,
  ASSISTANT_MESSAGE_SELECTORS,
  queryFirst,
  queryAll,
} from './gemini-selectors';

/**
 * Detection utilities for Gemini page state.
 */

export function isLoggedIn(): boolean {
  if (getComposer()) return true;
  const loginBtn = document.querySelector('a[href*="accounts.google.com"]');
  if (loginBtn) return false;
  return true;
}

export function isReady(): boolean {
  const composer = getComposer();
  if (!composer) return false;

  if (composer instanceof HTMLElement) {
    if (composer.getAttribute('contenteditable') === 'false') return false;
    if ((composer as HTMLTextAreaElement).disabled) return false;
  }

  return !isGenerating();
}

export function isGenerating(): boolean {
  const el = queryFirst(STREAMING_INDICATORS);
  if (!el) return false;

  // In background tabs, getBoundingClientRect() returns 0 width/height.
  // When the tab is hidden, we check if the element has display !== 'none' and visibility !== 'hidden'.
  if (document.hidden) {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function getComposer(): Element | null {
  return queryFirst(COMPOSER_SELECTORS);
}

export function getSendButton(): HTMLButtonElement | null {
  const btn = queryFirst(SEND_BUTTON_SELECTORS);
  return btn as HTMLButtonElement | null;
}

export function isSendEnabled(): boolean {
  const btn = getSendButton();
  if (!btn) return false;
  return !btn.disabled && !btn.getAttribute('aria-disabled');
}

export function getAssistantMessageCount(): number {
  return queryAll(ASSISTANT_MESSAGE_SELECTORS).length;
}

export function getLastAssistantMessage(): Element | null {
  const messages = queryAll(ASSISTANT_MESSAGE_SELECTORS);
  return messages.length > 0 ? messages[messages.length - 1] : null;
}

/** Check if Gemini shows any usage/rate limit warnings */
export function getLimitError(): string | null {
  const selectors = [
    '.banner',
    '[class*="banner"]',
    '[class*="alert"]',
    '[class*="notice"]',
    '[class*="error"]',
    'div[role="alert"]',
    'span',
    'div'
  ];

  for (const selector of selectors) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const text = el.textContent || '';
        if (text.includes('reached your image generation limit') ||
            text.includes('usage limit reached') ||
            text.includes('quota exceeded') ||
            text.includes('resource exhausted') ||
            text.includes('try again later') ||
            text.includes('Gemini Advanced required')) {
          
          if (el.children.length <= 6 && text.trim().length > 10 && text.trim().length < 300) {
            return text.trim().replace(/\s+/g, ' ');
          }
        }
      }
    } catch {
      // Ignore invalid selectors
    }
  }

  // Check composer parent for Gemini
  const composer = getComposer();
  if (composer) {
    let parent = composer.parentElement;
    for (let depth = 0; depth < 5 && parent; depth++) {
      const text = parent.textContent || '';
      if (text.includes('limit reached') || text.includes('try again later') || text.includes('exceeded')) {
        const matches = text.match(/(reached your image generation limit[^]*?|usage limit reached[^]*?|quota exceeded[^]*?|resource exhausted[^]*?)/i);
        if (matches) {
          return matches[0].trim().replace(/\s+/g, ' ');
        }
      }
      parent = parent.parentElement;
    }
  }

  return null;
}
