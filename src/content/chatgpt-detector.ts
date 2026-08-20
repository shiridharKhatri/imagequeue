import {
  COMPOSER_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STREAMING_INDICATORS,
  ASSISTANT_MESSAGE_SELECTORS,
  queryFirst,
  queryAll,
} from './chatgpt-selectors';

/**
 * Detection utilities for ChatGPT page state.
 * All functions operate on the current DOM and return synchronously.
 */

/** Check if the user appears to be logged in */
export function isLoggedIn(): boolean {
  // If there's a composer, the user is logged in
  if (getComposer()) return true;

  // Check for login page indicators
  const loginButton = document.querySelector('button[data-testid="login-button"]');
  if (loginButton) return false;

  // Check for auth wall
  const authWall = document.querySelector('[class*="auth"]');
  if (authWall) return false;

  // Assume logged in if we can find navigation
  const nav = document.querySelector('nav');
  return !!nav;
}

/** Check if ChatGPT is ready to accept input */
export function isReady(): boolean {
  const composer = getComposer();
  if (!composer) return false;

  // Check if composer is not disabled
  if (composer instanceof HTMLElement) {
    if (composer.getAttribute('contenteditable') === 'false') return false;
    if ((composer as HTMLTextAreaElement).disabled) return false;
  }

  // Check that generation is not in progress
  return !isGenerating();
}

/** Check if ChatGPT is currently generating a response */
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

/** Get the message composer element */
export function getComposer(): Element | null {
  return queryFirst(COMPOSER_SELECTORS);
}

/** Get the send button */
export function getSendButton(): HTMLButtonElement | null {
  const btn = queryFirst(SEND_BUTTON_SELECTORS);
  return btn as HTMLButtonElement | null;
}

/** Check if the send button is enabled */
export function isSendEnabled(): boolean {
  const btn = getSendButton();
  if (!btn) return false;
  return !btn.disabled && !btn.getAttribute('aria-disabled');
}

/** Get the count of assistant messages currently visible */
export function getAssistantMessageCount(): number {
  return queryAll(ASSISTANT_MESSAGE_SELECTORS).length;
}

/** Get the last assistant message element */
export function getLastAssistantMessage(): Element | null {
  const messages = queryAll(ASSISTANT_MESSAGE_SELECTORS);
  return messages.length > 0 ? messages[messages.length - 1] : null;
}

/** Check if ChatGPT shows any usage/rate limit warnings */
export function getLimitError(): string | null {
  // 1. Scan for banners or alert blocks
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
        if (text.includes('Chat paused until usage resets') ||
            text.includes('reached the limit') ||
            text.includes('too many requests') ||
            text.includes('rate limit') ||
            text.includes('limit for chats') ||
            text.includes('upgrade to Plus') ||
            text.includes('upgrade to continue') ||
            text.includes('usage resets at')) {
          
          // Filter to avoid matching massive wrappers (like body or main container)
          if (el.children.length <= 6 && text.trim().length > 10 && text.trim().length < 300) {
            return text.trim().replace(/\s+/g, ' ');
          }
        }
      }
    } catch {
      // Ignore invalid selectors
    }
  }

  // 2. Scan composer parent for error messages
  const composer = getComposer();
  if (composer) {
    let parent = composer.parentElement;
    for (let depth = 0; depth < 5 && parent; depth++) {
      const text = parent.textContent || '';
      if (text.includes('resets at') || text.includes('usage limit') || text.includes('paused until')) {
        // Find if there is a specific warning text block in the composer area
        const matches = text.match(/(Chat paused until[^]*?|You’ve reached the limit[^]*?|Limit reached[^]*?)/i);
        if (matches) {
          return matches[0].trim().replace(/\s+/g, ' ');
        }
      }
      parent = parent.parentElement;
    }
  }

  return null;
}
