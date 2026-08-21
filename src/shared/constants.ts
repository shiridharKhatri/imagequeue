import type { ExtensionSettings, ImageFormat } from './types';

// ─── ChatGPT ───────────────────────────────────────────────────

export const DEFAULT_CHATGPT_DOMAIN = 'chatgpt.com';
export const CHATGPT_URL_PATTERN = '*://chatgpt.com/*';
export const CHATGPT_BASE_URL = 'https://chatgpt.com';

export const DEFAULT_GEMINI_DOMAIN = 'gemini.google.com';
export const GEMINI_URL_PATTERN = '*://gemini.google.com/*';
export const GEMINI_BASE_URL = 'https://gemini.google.com';

// ─── Queue ─────────────────────────────────────────────────────

export const MAX_RETRIES_DEFAULT = 3;
export const GENERATION_TIMEOUT_MS = 300_000; // 5 minutes
export const QUEUE_RECOVERY_ALARM = 'image-queue-recovery';
export const QUEUE_RECOVERY_INTERVAL_MIN = 1; // chrome.alarms minimum

// ─── Image Processing ──────────────────────────────────────────

export const SUPPORTED_FORMATS: ImageFormat[] = ['png', 'jpg', 'webp'];
export const DEFAULT_QUALITY = 90;
export const DEFAULT_MAX_WIDTH = 0; // 0 = original
export const MAX_WIDTH_OPTIONS = [0, 1920, 1600, 1200, 1000, 800];
export const MAX_WIDTH_LABELS: Record<number, string> = {
  0: 'Original',
  1920: '1920px',
  1600: '1600px',
  1200: '1200px',
  1000: '1000px',
  800: '800px',
};

// ─── Storage Keys ──────────────────────────────────────────────

export const STORAGE_KEY_QUEUE = 'iq_queue';
export const STORAGE_KEY_SETTINGS = 'iq_settings';
export const STORAGE_KEY_LOGS = 'iq_logs';

// ─── Timing ────────────────────────────────────────────────────

export const KEEPALIVE_INTERVAL_MS = 20_000; // 20s heartbeat
export const MUTATION_OBSERVER_TIMEOUT_MS = GENERATION_TIMEOUT_MS;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
export const CONTENT_SCRIPT_READY_TIMEOUT_MS = 5_000;

// ─── Logging ───────────────────────────────────────────────────

export const MAX_LOG_ENTRIES = 200;
export const PROMPT_PREVIEW_LENGTH = 60;

// ─── Default Settings ──────────────────────────────────────────

export const DEFAULT_SETTINGS: ExtensionSettings = {
  activeProvider: 'chatgpt',
  chatgptDomain: DEFAULT_CHATGPT_DOMAIN,
  geminiDomain: DEFAULT_GEMINI_DOMAIN,
  maxRetries: MAX_RETRIES_DEFAULT,
  generationTimeoutMs: GENERATION_TIMEOUT_MS,
  defaultFormat: 'webp',
  defaultQuality: DEFAULT_QUALITY,
  defaultResolution: '0',
  defaultFilenamePrefix: 'image',
  autoZipOnComplete: false,
  deleteAfterZip: false,
  pauseOnFailure: true,
  newConversationPerPrompt: false,
  wpEnabled: true,
  wpSiteUrl: '',
  wpApiKey: '',
  authorName: '',
};

// ─── UI ────────────────────────────────────────────────────────

export const DEFAULT_PROMPT_COUNT = 6;
export const MIN_PROMPTS = 1;
export const MAX_PROMPTS = 20;
