import type {
  QueueData,
  QueueItem,
  QueueState,
  ImageGenerationProvider,
  GeneratedImage,
} from '../shared/types';
import { queueStorage } from '../storage/storage';
import { logger } from '../shared/logger';
import { createQueueItem, findNextItem, isQueueFinished } from './queue-types';

export type QueueEventCallback = (queue: QueueData) => void;

/**
 * QueueManager owns the queue lifecycle. It:
 * - Persists state after every mutation
 * - Processes items one at a time through an ImageGenerationProvider
 * - Handles retry, pause, resume, cancel
 * - Recovers from service-worker restart
 *
 * The manager knows NOTHING about ChatGPT — only about ImageGenerationProvider.
 */
export class QueueManager {
  private queue: QueueData;
  private provider: ImageGenerationProvider | null = null;
  private processing = false;
  private onUpdate: QueueEventCallback | null = null;
  private maxRetries = 3;
  private generationTimeoutMs = 120_000;
  private pauseOnFailure = true;

  /** Callback for downloading images — injected by service worker */
  public onImageDownload:
    | ((itemId: string, imageUrl: string) => Promise<boolean>)
    | null = null;

  constructor() {
    this.queue = this.emptyQueue();
  }

  private emptyQueue(): QueueData {
    return {
      state: 'idle',
      items: [],
      articleName: '',
      updatedAt: Date.now(),
    };
  }

  // ─── Configuration ───────────────────────────────────────────

  setProvider(provider: ImageGenerationProvider): void {
    this.provider = provider;
  }

  setOnUpdate(callback: QueueEventCallback): void {
    this.onUpdate = callback;
  }

  setMaxRetries(n: number): void {
    this.maxRetries = n;
  }

  setGenerationTimeout(ms: number): void {
    this.generationTimeoutMs = ms;
  }

  setPauseOnFailure(pause: boolean): void {
    this.pauseOnFailure = pause;
  }

  // ─── State Access ────────────────────────────────────────────

  getQueue(): QueueData {
    return { ...this.queue, items: [...this.queue.items] };
  }

  getState(): QueueState {
    return this.queue.state;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  // ─── Queue Operations ────────────────────────────────────────

  /**
   * Initialize the queue with prompts and start processing.
   */
  async start(articleName: string, prompts: string[], refImageKeys?: (string | undefined)[]): Promise<void> {
    if (prompts.length === 0) {
      throw new Error('No prompts provided');
    }

    if (this.provider?.resetSession) {
      this.provider.resetSession();
    }

    const items = prompts.map((p, idx) => createQueueItem(p, refImageKeys?.[idx]));

    this.queue = {
      state: 'running',
      items,
      articleName: articleName || 'image',
      updatedAt: Date.now(),
    };

    await this.persist();
    logger.info('Queue started', {
      articleName,
      itemCount: items.length,
    });

    this.processNext();
  }

  /**
   * Add items to an existing queue (append).
   */
  async addItems(prompts: string[]): Promise<void> {
    const newItems = prompts.map((p) => createQueueItem(p));
    this.queue.items.push(...newItems);
    this.queue.updatedAt = Date.now();
    await this.persist();
    logger.info('Items added to queue', { count: newItems.length });

    // If the queue was completed/idle and we added more, resume
    if (this.queue.state === 'completed' || this.queue.state === 'idle') {
      this.queue.state = 'running';
      await this.persist();
      this.processNext();
    }
  }

  /**
   * Pause: finish current generation, don't start another.
   */
  async pause(): Promise<void> {
    if (this.queue.state !== 'running') return;
    this.queue.state = 'paused';
    this.queue.updatedAt = Date.now();
    await this.persist();
    logger.info('Queue paused');
  }

  /**
   * Resume processing from the next queued item.
   */
  async resume(): Promise<void> {
    if (this.queue.state !== 'paused' && this.queue.state !== 'error') return;
    this.queue.state = 'running';
    this.queue.updatedAt = Date.now();
    await this.persist();
    logger.info('Queue resumed');
    this.processNext();
  }

  /**
   * Cancel all remaining items but keep completed ones.
   */
  async cancel(): Promise<void> {
    for (const item of this.queue.items) {
      if (item.status === 'queued' || item.status === 'generating') {
        item.status = 'cancelled';
      }
    }
    this.queue.state = 'completed';
    this.queue.updatedAt = Date.now();
    await this.persist();
    logger.info('Queue cancelled');
  }

  /**
   * Retry a specific failed item.
   */
  async retryItem(itemId: string): Promise<void> {
    const item = this.queue.items.find((i) => i.id === itemId);
    if (!item || item.status !== 'failed') return;

    item.status = 'queued';
    item.error = undefined;
    item.retryCount = 0;
    this.queue.updatedAt = Date.now();
    await this.persist();
    logger.info('Item retry requested', { itemId });

    // Resume if paused/error
    if (this.queue.state === 'paused' || this.queue.state === 'error' || this.queue.state === 'completed') {
      this.queue.state = 'running';
      await this.persist();
      this.processNext();
    }
  }

  /**
   * Skip a failed item (mark as cancelled, continue queue).
   */
  async skipItem(itemId: string): Promise<void> {
    const item = this.queue.items.find((i) => i.id === itemId);
    if (!item) return;

    item.status = 'cancelled';
    this.queue.updatedAt = Date.now();

    if (this.queue.state === 'paused' || this.queue.state === 'error') {
      this.queue.state = 'running';
    }

    await this.persist();
    logger.info('Item skipped', { itemId });
    this.processNext();
  }

  /**
   * Remove an item from the queue entirely.
   */
  async removeItem(itemId: string): Promise<void> {
    this.queue.items = this.queue.items.filter((i) => i.id !== itemId);
    this.queue.updatedAt = Date.now();
    await this.persist();
    logger.info('Item removed', { itemId });
  }

  /**
   * Clear the entire queue and reset to idle.
   */
  async clearQueue(): Promise<void> {
    this.queue = this.emptyQueue();
    await this.persist();
    if (this.provider?.resetSession) {
      this.provider.resetSession();
    }
    logger.info('Queue cleared');
  }

  /**
   * Restore queue from storage (called on service worker restart).
   */
  async restore(): Promise<void> {
    const saved = await queueStorage.load();
    if (!saved) {
      logger.debug('No saved queue found');
      return;
    }

    this.queue = saved;
    logger.info('Queue restored from storage', {
      state: saved.state,
      itemCount: saved.items.length,
    });

    // If the queue was running, a generating item may have been interrupted
    const generating = this.queue.items.find((i) => i.status === 'generating');
    if (generating) {
      logger.warn('Found interrupted generation, re-queuing', {
        itemId: generating.id,
      });
      generating.status = 'queued';
      generating.retryCount++;
      await this.persist();
    }

    // Resume processing if the queue was running
    if (this.queue.state === 'running') {
      logger.info('Resuming queue after restart');
      this.processNext();
    }
  }

  // ─── Processing Loop ─────────────────────────────────────────

  private async processNext(): Promise<void> {
    // Guard: don't start multiple concurrent processes
    if (this.processing) return;

    // Guard: check state
    if (this.queue.state !== 'running') return;

    // Guard: check provider
    if (!this.provider) {
      logger.error('No image generation provider set');
      this.queue.state = 'error';
      await this.persist();
      return;
    }

    const nextItem = findNextItem(this.queue.items);

    if (!nextItem) {
      // All items processed
      if (isQueueFinished(this.queue.items)) {
        this.queue.state = 'completed';
        this.queue.updatedAt = Date.now();
        await this.persist();
        logger.info('Queue completed');
      }
      return;
    }

    this.processing = true;

    try {
      // Check provider availability
      const available = await this.provider.isAvailable();
      if (!available) {
        logger.warn('Provider not available, pausing queue');
        this.queue.state = 'paused';
        await this.persist();
        this.processing = false;
        return;
      }

      // Mark as generating
      nextItem.status = 'generating';
      nextItem.error = undefined; // Clear previous retry error
      this.queue.updatedAt = Date.now();
      await this.persist();
      logger.info(`Processing item ${this.queue.items.indexOf(nextItem) + 1}`, {
        itemId: nextItem.id,
        prompt: logger.truncatePrompt(nextItem.prompt),
      });

      // Generate with timeout
      const result = await this.withTimeout(
        this.provider.generateImage(nextItem.prompt, nextItem.refImageKey),
        this.generationTimeoutMs
      );

      // Download the image
      if (this.onImageDownload) {
        const downloaded = await this.onImageDownload(nextItem.id, result.url);
        if (!downloaded) {
          throw new Error('Image download/validation failed');
        }
      }

      // Success - only set completed if not cancelled while generating
      if (nextItem.status === 'generating') {
        nextItem.status = 'completed';
        nextItem.imageUrl = result.url;
        nextItem.imageStoreKey = nextItem.id;
        nextItem.completedAt = Date.now();
        nextItem.error = undefined; // Clear error on success
        this.queue.updatedAt = Date.now();
        await this.persist();
        
        const idx = this.queue.items.indexOf(nextItem) + 1;
        logger.info(`Item ${idx} completed`);
      } else {
        logger.info('Item generation finished but item was already cancelled');
      }
    } catch (err) {
      await this.handleItemFailure(nextItem, err);
    } finally {
      this.processing = false;
    }

    // Continue to next item (if still running)
    if (this.queue.state === 'running') {
      // Small delay to avoid overwhelming ChatGPT
      setTimeout(() => this.processNext(), 2000);
    }
  }

  private async handleItemFailure(item: QueueItem, err: unknown): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const idx = this.queue.items.indexOf(item) + 1;

    const lowerError = errorMessage.toLowerCase();
    const isRateLimit = lowerError.includes('limit') || 
                        lowerError.includes('quota') ||
                        lowerError.includes('rate limit') ||
                        lowerError.includes('paused until') ||
                        lowerError.includes('too many requests') ||
                        lowerError.includes('resource exhausted');

    if (isRateLimit) {
      // Do NOT increment retryCount or auto-retry; set to failed and pause queue immediately!
      item.status = 'failed';
      item.error = errorMessage;
      logger.error(`Item ${idx} failed due to rate/usage limit. Pausing queue.`, {
        error: errorMessage,
      });

      this.queue.state = 'error'; // Set state to error (stops the queue and displays paused/error in popup)
      logger.warn('Queue paused due to rate/usage limit error');
    } else {
      const isContentPolicy = lowerError.includes('content policy') ||
                              lowerError.includes('violate') ||
                              lowerError.includes('policy violation') ||
                              lowerError.includes('against our policy') ||
                              lowerError.includes("can't generate") ||
                              lowerError.includes("cannot generate");

      if (isContentPolicy) {
        // Fail immediately, do NOT retry, and do NOT pause the queue!
        item.status = 'failed';
        item.error = `Content Policy Blocked: ${errorMessage}`;
        logger.warn(`Item ${idx} failed due to content policy violation. Bypassing/skipping.`, {
          error: errorMessage,
        });
      } else {
        item.retryCount++;
        if (item.retryCount < this.maxRetries) {
          // Auto-retry
          item.status = 'queued';
          item.error = errorMessage;
          logger.warn(`Item ${idx} failed, will retry (${item.retryCount}/${this.maxRetries})`, {
            error: errorMessage,
          });
        } else {
          // Max retries exceeded
          item.status = 'failed';
          item.error = errorMessage;
          logger.error(`Item ${idx} failed after ${this.maxRetries} attempts`, {
            error: errorMessage,
          });

          if (this.pauseOnFailure) {
            this.queue.state = 'error';
            logger.warn('Queue paused due to failed item');
          }
        }
      }
    }

    this.queue.updatedAt = Date.now();
    await this.persist();
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Generation timed out after ${ms / 1000}s`));
      }, ms);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  // ─── Persistence ─────────────────────────────────────────────

  private async persist(): Promise<void> {
    await queueStorage.save(this.queue);
    this.emitUpdate();
  }

  private emitUpdate(): void {
    if (this.onUpdate) {
      try {
        this.onUpdate(this.getQueue());
      } catch {
        // Callback errors shouldn't break queue processing
      }
    }
  }
}
