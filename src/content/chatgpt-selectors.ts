/**
 * Centralized ChatGPT DOM selectors.
 *
 * All selectors are defined here as ordered fallback chains.
 * When ChatGPT updates their UI, ONLY this file needs to change.
 *
 * Each selector list is tried in order; the first match wins.
 */

export const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[contenteditable="true"][data-placeholder]',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
  'textarea[data-id="root"]',
] as const;

export const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label*="Send"]',
  'form button[type="submit"]',
  // Fallback: find the button near the composer
  'div[class*="composer"] button:last-of-type',
] as const;

/** Selectors for the "stop generating" button — indicates active generation */
export const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
] as const;

/** Selectors for generated images in assistant messages (run against assistant message container) */
export const IMAGE_SELECTORS = [
  'img[src*="oaiusercontent"]',
  'img[src*="dalle"]',
  'img[alt]',
  '.group img',
  'img',
] as const;

/** Selectors for the download button on an image */
export const IMAGE_DOWNLOAD_SELECTORS = [
  'a[download][href*="oaiusercontent"]',
  'a[download]',
  'button[aria-label*="Download"]',
] as const;

/** Selectors indicating ChatGPT is streaming/generating */
export const STREAMING_INDICATORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
  'button[data-testid="fruitjuice-send-button"] svg[class*="stop"]',
  'div[class*="result-streaming"]',
  'div[class*="result-thinking"]',
  '[data-is-streaming="true"]',
  '.result-streaming',
  '.typing-indicator',
] as const;

/** Selectors for the "New Chat" / new conversation button */
export const NEW_CHAT_SELECTORS = [
  'a[href="/"]',
  'nav a[class*="new"]',
  'button[aria-label*="New chat"]',
  'a[data-testid="create-new-chat-button"]',
] as const;

/** Assistant message container for scoping image search */
export const ASSISTANT_MESSAGE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  'article[data-message-author-role="assistant"]',
  'div[data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  '[data-testid="assistant-message"]',
  'div[class*="agent-turn"]',
  '.agent-turn',
] as const;

/**
 * Try a list of selectors against a parent element.
 * Returns the first matching element or null.
 */
export function queryFirst(
  selectors: readonly string[],
  parent: Document | Element = document
): Element | null {
  for (const selector of selectors) {
    try {
      const el = parent.querySelector(selector);
      if (el) return el;
    } catch {
      // Invalid selector, skip
    }
  }
  return null;
}

/**
 * Try a list of selectors and return ALL matching elements from the first selector
 * that yields results (following the ordered fallback chain design).
 */
export function queryAll(
  selectors: readonly string[],
  parent: Document | Element = document
): Element[] {
  for (const selector of selectors) {
    try {
      const elements = parent.querySelectorAll(selector);
      if (elements.length > 0) {
        const arr = Array.from(elements);
        // Filter out nested duplicates: keep outermost element
        return arr.filter((el, i) => !arr.some((other, j) => i !== j && other.contains(el)));
      }
    } catch {
      // Invalid selector, skip
    }
  }

  return [];
}
