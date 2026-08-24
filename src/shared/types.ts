// ─── Queue Item ────────────────────────────────────────────────

export type QueueItemStatus =
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface QueueItem {
  /** Unique identifier (crypto.randomUUID) */
  id: string;
  /** The image-generation prompt */
  prompt: string;
  /** Current processing status */
  status: QueueItemStatus;
  /** URL of the generated image (from ChatGPT) */
  imageUrl?: string;
  /** Key used to retrieve the blob from ImageStore */
  imageStoreKey?: string;
  /** Original filename or label */
  localFilename?: string;
  /** Error message if status is 'failed' */
  error?: string;
  /** Epoch ms when the item was created */
  createdAt: number;
  /** Epoch ms when generation completed */
  completedAt?: number;
  /** Number of retry attempts so far */
  retryCount: number;
  /** Key of the individual reference image in ImageStore */
  refImageKey?: string;
}

// ─── Queue State ───────────────────────────────────────────────

export type QueueState = 'idle' | 'running' | 'paused' | 'completed' | 'error';

export interface QueueData {
  /** Overall queue state */
  state: QueueState;
  /** Ordered list of items */
  items: QueueItem[];
  /** Article name / session label */
  articleName: string;
  /** Epoch ms of last state change */
  updatedAt: number;
}

// ─── Image Generation Provider ─────────────────────────────────

export interface GeneratedImage {
  /** The downloadable image URL */
  url: string;
  /** Width in pixels (if known) */
  width?: number;
  /** Height in pixels (if known) */
  height?: number;
}

/**
 * Abstraction over any image-generation backend.
 * The queue manager only interacts with this interface —
 * never directly with ChatGPT, API, or any other provider.
 */
export interface ImageGenerationProvider {
  /** Check whether the provider is available and ready */
  isAvailable(): Promise<boolean>;

  /** Generate an image from a text prompt */
  generateImage(prompt: string, refImageKey?: string, itemId?: string): Promise<GeneratedImage>;

  /** Optional: reset provider session-based states */
  resetSession?(): void;

  /** Optional: check if the provider is currently generating a specific item in the content script */
  isCurrentlyGenerating?(itemId: string): Promise<boolean>;
}

// ─── Image Processing ──────────────────────────────────────────

export type ImageFormat = 'png' | 'jpg' | 'webp' | 'avif' | 'tiff' | 'def';

export interface ProcessingOptions {
  /** Optional custom AI background removal API URL */
  customBgRemovalUrl?: string;
  /** Image processing mode (local JS canvas vs Python FastAPI server) */
  imageProcessingMode?: 'local' | 'api';
  /** Internal flag indicating if background removal is requested */
  bgRemoveFlag?: boolean;
  /** Internal flag indicating if transparent cropping is requested */
  cropFlag?: boolean;
  /** Internal flag indicating if background color filling is requested */
  bgColorEnableFlag?: boolean;
  /** Internal background color hex value */
  bgColorValueFlag?: string;
  /** If true, use scale-to-fit (contain) instead of crop-to-fill (cover) for WxH resolutions */
  containFit?: boolean;
  /** Output image format */
  format: ImageFormat;
  /** Quality 1-100 (applicable to jpg and webp) */
  quality: number;
  /** Optional target size in KB (quality will be dynamically adjusted to fit) */
  targetSizeKb?: number;
  /** Target resolution (e.g. "0", "1200", "1200x628"). "0" = original. */
  resolution: string;
  /** Filename prefix for output files */
  filenamePrefix: string;
  /** Optional custom filenames mapping item.id -> custom name (no extension) */
  customFilenames?: Record<string, string>;
  /** Optional custom background removal mapping item.id -> boolean */
  bgRemove?: Record<string, boolean>;
  /** Optional custom crop mapping item.id -> boolean */
  crop?: Record<string, boolean>;
  /** Optional custom resolution mapping item.id -> string */
  customResolutions?: Record<string, string>;
  /** Optional custom format mapping item.id -> format string (e.g. 'webp', 'jpg', 'png') */
  customFormats?: Record<string, string>;
  /** Optional custom background color enable mapping item.id -> boolean */
  bgColorEnable?: Record<string, boolean>;
  /** Optional custom background color hex value mapping item.id -> string */
  bgColorValue?: Record<string, string>;
  /** Optional custom EXIF metadata mapping item.id -> metadata */
  customMetadata?: Record<string, {
    title?: string;
    author?: string;
    description?: string;
    make?: string;
    model?: string;
    lensModel?: string;
    software?: string;
    copyright?: string;
    country?: string;
    state?: string;
    city?: string;
    subLocation?: string;
    gpsLatitude?: string;
    gpsLongitude?: string;
    dateTimeOriginal?: string;
  }>;
  /** Optional default EXIF metadata to embed if no custom metadata is provided */
  metadata?: {
    title?: string;
    author?: string;
    description?: string;
    make?: string;
    model?: string;
    lensModel?: string;
    software?: string;
    copyright?: string;
    country?: string;
    state?: string;
    city?: string;
    subLocation?: string;
    gpsLatitude?: string;
    gpsLongitude?: string;
    dateTimeOriginal?: string;
  };
  /** Optional image adjustments/filters */
  adjustments?: {
    brightness: number;  // 50 - 150
    contrast: number;    // 50 - 150
    saturation: number;  // 0 - 200
    grayscale: number;   // 0 - 100
    rotate: number;      // 0, 90, 180, 270
    flipH: boolean;
    flipV: boolean;
  };
}

// ─── Settings ──────────────────────────────────────────────────

export interface ExtensionSettings {
  /** Active image generation provider */
  activeProvider: 'chatgpt' | 'gemini';
  /** ChatGPT domain (default: chatgpt.com) */
  chatgptDomain: string;
  /** Gemini domain (default: gemini.google.com) */
  geminiDomain: string;
  /** Maximum auto-retry count per item */
  maxRetries: number;
  /** Generation timeout in ms */
  generationTimeoutMs: number;
  /** Default output format */
  defaultFormat: ImageFormat;
  /** Default quality */
  defaultQuality: number;
  /** Default resolution (e.g. "0", "1200", "1200x628") */
  defaultResolution: string;
  /** Default filename prefix */
  defaultFilenamePrefix: string;
  /** Automatically create ZIP when queue completes */
  autoZipOnComplete: boolean;
  /** Delete temporary image blobs after ZIP download */
  deleteAfterZip: boolean;
  /** Pause queue on failed item (vs. skip) */
  pauseOnFailure: boolean;
  /** Use new ChatGPT conversation for each prompt */
  newConversationPerPrompt: boolean;
  /** Enable WordPress Upload */
  wpEnabled: boolean;
  /** WordPress Site URL */
  wpSiteUrl: string;
  /** WordPress API Key */
  wpApiKey: string;
  /** Default Author Name */
  authorName: string;
  /** Custom AI Background Removal API URL (e.g. https://imagetool.api.dailyworkreport.com/remove-bg) */
  customBgRemovalUrl?: string;
  /** Image processing mode (local JS canvas vs Python FastAPI server) */
  imageProcessingMode?: 'local' | 'api';
}

// ─── ChatGPT Detection ────────────────────────────────────────

export interface ChatGPTStatus {
  tabFound: boolean;
  tabId?: number;
  loggedIn: boolean;
  ready: boolean;
  composerFound: boolean;
}

export interface GeminiStatus {
  tabFound: boolean;
  tabId?: number;
  loggedIn: boolean;
  ready: boolean;
  composerFound: boolean;
}

// ─── Diagnostics ───────────────────────────────────────────────

export interface DiagnosticsInfo {
  chatgptTabDetected: boolean;
  chatgptReady: boolean;
  queueWorkerRunning: boolean;
  downloadsPermission: boolean;
  storageUsedBytes: number;
}

// ─── Log Entry ─────────────────────────────────────────────────

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}
