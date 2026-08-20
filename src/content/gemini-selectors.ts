/**
 * Centralized Gemini DOM selectors.
 *
 * Each selector list is tried in order; the first match wins.
 */

export const COMPOSER_SELECTORS = [
  '.ql-editor[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'rich-textarea div[contenteditable="true"]',
  'div[contenteditable="true"]',
  'textarea',
] as const;

export const SEND_BUTTON_SELECTORS = [
  'button[aria-label="Send message"]',
  'button.send-button',
  'button[aria-label*="Send"]',
  'button[aria-label*="Submit"]',
  '.send-button-container button',
] as const;

export const STOP_BUTTON_SELECTORS = [
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
  'button.stop-button',
] as const;

export const IMAGE_SELECTORS = [
  'img[src*="googleusercontent.com"]',
  'img[src*="google"]',
  'img',
] as const;

export const IMAGE_DOWNLOAD_SELECTORS = [
  'a[download]',
  'button[aria-label*="Download"]',
] as const;

export const STREAMING_INDICATORS = [
  'mat-progress-spinner',
  '.progress-spinner',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop response"]',
  'button[aria-label*="Stop"]',
  '.spark-loader',
  '.generating',
  '.loading',
  '[role="progressbar"]',
] as const;

export const NEW_CHAT_SELECTORS = [
  'a[href="/app"]',
  'a[href*="gemini.google.com/app"]',
  'button[aria-label*="New chat"]',
  '.new-chat-button',
] as const;

export const ASSISTANT_MESSAGE_SELECTORS = [
  'message-content[role="presentation"]',
  'message-content',
  '.chat-turn-assistant',
  '.message[data-role="assistant"]',
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
 * Try a list of selectors and return ALL matching elements.
 */
export function queryAll(
  selectors: readonly string[],
  parent: Document | Element = document
): Element[] {
  const results: Element[] = [];
  const seen = new Set<Element>();

  for (const selector of selectors) {
    try {
      const elements = parent.querySelectorAll(selector);
      for (const el of elements) {
        if (!seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      }
    } catch {
      // Invalid selector, skip
    }
  }

  return results;
}
