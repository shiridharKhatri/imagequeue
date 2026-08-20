import type {
  QueueData,
  QueueItem,
  ChatGPTStatus,
  ProcessingOptions,
  LogEntry,
  DiagnosticsInfo,
  ExtensionSettings,
} from './types';

// ─── Message Types ─────────────────────────────────────────────

export const MSG = {
  // Popup → Service Worker
  START_QUEUE: 'START_QUEUE',
  PAUSE_QUEUE: 'PAUSE_QUEUE',
  RESUME_QUEUE: 'RESUME_QUEUE',
  CANCEL_QUEUE: 'CANCEL_QUEUE',
  RETRY_ITEM: 'RETRY_ITEM',
  REMOVE_ITEM: 'REMOVE_ITEM',
  SKIP_ITEM: 'SKIP_ITEM',
  GET_QUEUE_STATUS: 'GET_QUEUE_STATUS',
  GET_DIAGNOSTICS: 'GET_DIAGNOSTICS',
  PROCESS_IMAGES: 'PROCESS_IMAGES',
  DOWNLOAD_ZIP: 'DOWNLOAD_ZIP',
  DOWNLOAD_INDIVIDUAL: 'DOWNLOAD_INDIVIDUAL',
  OPEN_CHATGPT: 'OPEN_CHATGPT',
  OPEN_GEMINI: 'OPEN_GEMINI',
  GET_SETTINGS: 'GET_SETTINGS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  GET_LOGS: 'GET_LOGS',
  CLEAR_LOGS: 'CLEAR_LOGS',
  CLEAR_QUEUE: 'CLEAR_QUEUE',

  // Service Worker → Popup (broadcast)
  QUEUE_STATUS_UPDATE: 'QUEUE_STATUS_UPDATE',
  LOG_ENTRY: 'LOG_ENTRY',

  // Service Worker → Content Script
  GENERATE_IMAGE: 'GENERATE_IMAGE',
  CHECK_CHATGPT: 'CHECK_CHATGPT',
  CHECK_GEMINI: 'CHECK_GEMINI',
  PING: 'PING',

  // Content Script → Service Worker
  IMAGE_GENERATED: 'IMAGE_GENERATED',
  GENERATION_FAILED: 'GENERATION_FAILED',
  CHATGPT_STATUS: 'CHATGPT_STATUS',
  CONTENT_SCRIPT_READY: 'CONTENT_SCRIPT_READY',
  KEEPALIVE: 'KEEPALIVE',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

// ─── Message Payloads ──────────────────────────────────────────

export interface StartQueuePayload {
  articleName: string;
  prompts: string[];
  hasRefImage?: boolean[];
}

export interface RetryItemPayload {
  itemId: string;
}

export interface RemoveItemPayload {
  itemId: string;
}

export interface SkipItemPayload {
  itemId: string;
}

export interface GenerateImagePayload {
  itemId: string;
  prompt: string;
  newConversation: boolean;
  refImageDataUrl?: string;
}

export interface ImageGeneratedPayload {
  itemId: string;
  imageUrl: string;
  width?: number;
  height?: number;
}

export interface GenerationFailedPayload {
  itemId: string;
  error: string;
}

export interface ProcessImagesPayload {
  options: ProcessingOptions;
}

export interface SaveSettingsPayload {
  settings: ExtensionSettings;
}

// ─── Generic Message Wrapper ───────────────────────────────────

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload?: T;
}

// ─── Type-Safe Message Helpers ─────────────────────────────────

export function createMessage<T>(type: MessageType, payload?: T): ExtensionMessage<T> {
  return { type, payload };
}

/**
 * Send a message to the service worker (from popup or content script).
 * Returns a typed response.
 */
export async function sendToBackground<TResponse = void>(
  type: MessageType,
  payload?: unknown
): Promise<TResponse> {
  return chrome.runtime.sendMessage(createMessage(type, payload));
}

/**
 * Send a message to a specific tab's content script.
 */
export async function sendToTab<TResponse = void>(
  tabId: number,
  type: MessageType,
  payload?: unknown,
  timeoutMs: number = 5000
): Promise<TResponse> {
  return new Promise<TResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Message ${type} to tab ${tabId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, createMessage(type, payload), (response) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
        } else {
          resolve(response as TResponse);
        }
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}
