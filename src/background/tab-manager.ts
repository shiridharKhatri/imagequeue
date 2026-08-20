import { DEFAULT_CHATGPT_DOMAIN, DEFAULT_GEMINI_DOMAIN } from '../shared/constants';
import { MSG, sendToTab } from '../shared/messages';
import type { ChatGPTStatus } from '../shared/types';
import { logger } from '../shared/logger';

/**
 * Manages ChatGPT tab discovery, content script injection, and communication.
 */

/** Find an open ChatGPT tab */
export async function findChatGPTTab(
  domain: string = DEFAULT_CHATGPT_DOMAIN
): Promise<chrome.tabs.Tab | null> {
  try {
    const tabs = await chrome.tabs.query({ url: `*://${domain}/*` });
    // Prefer active tabs, then most recently accessed
    const sorted = tabs.sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
    });
    return sorted[0] ?? null;
  } catch (err) {
    logger.error('Failed to query tabs', { error: String(err) });
    return null;
  }
}

/** Open a new ChatGPT tab */
export async function openChatGPTTab(
  domain: string = DEFAULT_CHATGPT_DOMAIN
): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.create({
    url: `https://${domain}`,
    active: false, // Don't steal focus from the writer
  });
  logger.info('Opened ChatGPT tab', { tabId: tab.id });
  return tab;
}

/**
 * Ensure the content script is loaded in a tab.
 * If not, inject it programmatically.
 */
export async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    // Try pinging the content script
    const response = await sendToTab<{ pong: boolean }>(tabId, MSG.PING);
    if (response?.pong) return true;
  } catch {
    // Content script not loaded — try injecting
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content-main.js'],
    });
    logger.info('Content script injected', { tabId });

    // Wait a moment for the script to initialize
    await new Promise((r) => setTimeout(r, 1000));
    return true;
  } catch (err) {
    logger.error('Failed to inject content script', {
      tabId,
      error: String(err),
    });
    return false;
  }
}

/**
 * Check the status of ChatGPT in a specific tab.
 */
export async function checkChatGPTStatus(
  tabId: number
): Promise<ChatGPTStatus> {
  try {
    const status = await sendToTab<ChatGPTStatus>(tabId, MSG.CHECK_CHATGPT);
    return status ?? {
      tabFound: true,
      loggedIn: false,
      ready: false,
      composerFound: false,
    };
  } catch {
    return {
      tabFound: false,
      loggedIn: false,
      ready: false,
      composerFound: false,
    };
  }
}

/** Find an open Gemini tab */
export async function findGeminiTab(
  domain: string = DEFAULT_GEMINI_DOMAIN
): Promise<chrome.tabs.Tab | null> {
  try {
    const tabs = await chrome.tabs.query({ url: `*://${domain}/*` });
    const sorted = tabs.sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
    });
    return sorted[0] ?? null;
  } catch (err) {
    logger.error('Failed to query Gemini tabs', { error: String(err) });
    return null;
  }
}

/** Open a new Gemini tab */
export async function openGeminiTab(
  domain: string = DEFAULT_GEMINI_DOMAIN
): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.create({
    url: `https://${domain}`,
    active: false,
  });
  logger.info('Opened Gemini tab', { tabId: tab.id });
  return tab;
}

/** Check status of Gemini in a specific tab */
export async function checkGeminiStatus(
  tabId: number
): Promise<ChatGPTStatus> {
  try {
    const status = await sendToTab<ChatGPTStatus>(tabId, MSG.CHECK_GEMINI);
    return status ?? {
      tabFound: true,
      loggedIn: false,
      ready: false,
      composerFound: false,
    };
  } catch {
    return {
      tabFound: false,
      loggedIn: false,
      ready: false,
      composerFound: false,
    };
  }
}

/**
 * Wait for a tab to finish loading.
 */
export function waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timed out'));
    }, timeoutMs);

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already loaded
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab not found'));
    });
  });
}
