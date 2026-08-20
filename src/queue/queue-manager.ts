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

    // Reset generating items that are no longer active in the tab
    for (const item of this.queue.items) {
      if (item.status === 'generating') {
        let active = false;
        if (this.provider && typeof this.provider.isCurrentlyGenerating === 'function') {
          active = await this.provider.isCurrentlyGenerating(item.id);
        }
        if (!active) {
          logger.warn('Resetting inactive generating item to queued on resume', { itemId: item.id });
          item.status = 'queued';
        }
      }
    }

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
      let stillActive = false;
      if (this.provider && typeof this.provider.isCurrentlyGenerating === 'function') {
        stillActive = await this.provider.isCurrentlyGenerating(generating.id);
      }

      if (stillActive) {
        logger.info('Active generation confirmed in tab. SW will wait for completion event.', {
          itemId: generating.id,
        });
      } else {
        logger.warn('Found interrupted generation, re-queuing', {
          itemId: generating.id,
        });
        generating.status = 'queued';
        generating.retryCount++;
        await this.persist();
      }
    }

    // Resume processing if the queue was running
    if (this.queue.state === 'running') {
      logger.info('Resuming queue after restart');
      this.processNext();
    }
  }

  /**
   * Handle completion of a queue item received from the provider callback.
   * This is used when the service worker restarts during a generation.
   */
  async handleExternalItemCompleted(itemId: string, imageUrl: string): Promise<void> {
    this.queue = (await queueStorage.load()) || this.queue;

    const item = this.queue.items.find((i) => i.id === itemId);
    if (item && item.status === 'generating') {
      logger.info('Handling external item completion (stateless recovery)', { itemId });
      
      try {
        if (this.onImageDownload) {
          const downloaded = await this.onImageDownload(item.id, imageUrl);
          if (!downloaded) {
            throw new Error('Image download/validation failed');
          }
        }
        
        item.status = 'completed';
        item.imageUrl = imageUrl;
        item.imageStoreKey = item.id;
        item.completedAt = Date.now();
        item.error = undefined;
      } catch (err) {
        item.status = 'failed';
        item.error = err instanceof Error ? err.message : String(err);
      }

      this.queue.updatedAt = Date.now();
      await this.persist();

      this.processing = false;
      this.processNext();
    }
  }

  /**
   * Handle failure of a queue item received from the provider callback.
   */
  async handleExternalItemFailed(itemId: string, error: string): Promise<void> {
    this.queue = (await queueStorage.load()) || this.queue;

    const item = this.queue.items.find((i) => i.id === itemId);
    if (item && item.status === 'generating') {
      logger.info('Handling external item failure (stateless recovery)', { itemId, error });
      
      item.status = 'failed';
      item.error = error;
      this.queue.updatedAt = Date.now();
      await this.persist();

      this.processing = false;
      this.processNext();
    }
  }

  // ─── Processing Loop ─────────────────────────────────────────

  private async processNext(): Promise<void> {
    // Guard: don't start multiple concurrent processes
    if (this.processing) return;

    // Guard: check if an item is already actively generating to prevent parallel loops
    if (this.queue.items.some((i) => i.status === 'generating')) {
      logger.debug('processNext guard: An item is already generating. Skipping execution.');
      return;
    }

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
      const currentItem = this.queue.items.find((i) => i.id === nextItem.id);
      if (!currentItem) return;

      currentItem.status = 'generating';
      currentItem.error = undefined; // Clear previous retry error
      this.queue.updatedAt = Date.now();
      await this.persist();

      const idx = this.queue.items.findIndex((i) => i.id === nextItem.id) + 1;
      logger.info(`Processing item ${idx}`, {
        itemId: nextItem.id,
        prompt: logger.truncatePrompt(nextItem.prompt),
      });

      // Generate with timeout
      const result = await this.withTimeout(
        this.provider.generateImage(nextItem.prompt, nextItem.refImageKey, nextItem.id),
        this.generationTimeoutMs
      );

      // Download the image
      if (this.onImageDownload) {
        const downloaded = await this.onImageDownload(nextItem.id, result.url);
        if (!downloaded) {
          throw new Error('Image download/validation failed');
        }
      }

      // Success - only set completed if not cancelled while generating (lookup by ID again in case queue reloaded)
      const successItem = this.queue.items.find((i) => i.id === nextItem.id);
      if (successItem && successItem.status === 'generating') {
        successItem.status = 'completed';
        successItem.imageUrl = result.url;
        successItem.imageStoreKey = successItem.id;
        successItem.completedAt = Date.now();
        successItem.error = undefined; // Clear error on success
        this.queue.updatedAt = Date.now();
        await this.persist();
        
        const completedIdx = this.queue.items.findIndex((i) => i.id === nextItem.id) + 1;
        logger.info(`Item ${completedIdx} completed`);
      } else {
        logger.info('Item generation finished but item was already cancelled or completed');
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
    const currentItem = this.queue.items.find((i) => i.id === item.id) || item;
    const errorMessage = err instanceof Error ? err.message : String(err);
    const idx = this.queue.items.findIndex((i) => i.id === item.id) + 1;

    const lowerError = errorMessage.toLowerCase();
    const isRateLimit = lowerError.includes('limit') || 
                        lowerError.includes('quota') ||
                        lowerError.includes('rate limit') ||
                        lowerError.includes('paused until') ||
                        lowerError.includes('too many requests') ||
                        lowerError.includes('resource exhausted');

    if (isRateLimit) {
      // Do NOT increment retryCount or auto-retry; set to failed and pause queue immediately!
      currentItem.status = 'failed';
      currentItem.error = errorMessage;
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
        currentItem.status = 'failed';
        currentItem.error = `Content Policy Blocked: ${errorMessage}`;
        logger.warn(`Item ${idx} failed due to content policy violation. Bypassing/skipping.`, {
          error: errorMessage,
        });
      } else {
        currentItem.retryCount++;
        if (currentItem.retryCount < this.maxRetries) {
          // Auto-retry
          currentItem.status = 'queued';
          currentItem.error = errorMessage;
          logger.warn(`Item ${idx} failed, will retry (${currentItem.retryCount}/${this.maxRetries})`, {
            error: errorMessage,
          });
        } else {
          // Max retries exceeded
          currentItem.status = 'failed';
          currentItem.error = errorMessage;
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
