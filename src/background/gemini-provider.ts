import type { ImageGenerationProvider, GeneratedImage } from '../shared/types';
import { MSG, sendToTab } from '../shared/messages';
import type { GenerateImagePayload, ImageGeneratedPayload, GenerationFailedPayload } from '../shared/messages';
import {
  findGeminiTab,
  ensureContentScript,
  checkGeminiStatus,
} from './tab-manager';
import { settingsStorage } from '../storage/storage';
import { logger } from '../shared/logger';
import { imageStore } from '../storage/image-store';

/**
 * GeminiProvider implements ImageGenerationProvider.
 *
 * It communicates with the content script on gemini.google.com
 * to generate images sequentially in the background.
 */
export class GeminiProvider implements ImageGenerationProvider {
  private geminiTabId: number | null = null;
  private pendingResolve: ((result: GeneratedImage) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private uploadedInCurrentSession = false;

  public onExternalCompleted?: (itemId: string, imageUrl: string) => void;
  public onExternalFailed?: (itemId: string, error: string) => void;

  /**
   * Check if Gemini tab is available and logged in.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const settings = await settingsStorage.load();
      const tab = await findGeminiTab(settings.geminiDomain);

      if (!tab || !tab.id) {
        logger.warn('No Gemini tab found');
        return false;
      }

      this.geminiTabId = tab.id;

      // Ensure content script is loaded
      const scriptReady = await ensureContentScript(tab.id);
      if (!scriptReady) {
        logger.warn('Content script not ready in Gemini tab');
        return false;
      }

      // Check status
      const status = await checkGeminiStatus(tab.id);
      if (!status.loggedIn) {
        logger.warn('Gemini tab exists but user is not logged in');
        return false;
      }

      return true;
    } catch (err) {
      logger.error('Gemini availability check failed', { error: String(err) });
      return false;
    }
  }

  /**
   * Send prompt to Gemini content script to generate image.
   */
  async generateImage(prompt: string, refImageKey?: string): Promise<GeneratedImage> {
    if (!this.geminiTabId) {
      const available = await this.isAvailable();
      if (!available) {
        throw new Error('Gemini tab not available');
      }
    }

    return new Promise<GeneratedImage>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      (async () => {
        let refImageDataUrl: string | undefined;
        try {
          const keyToLoad = refImageKey || 'ref-image-active';
          const activeRef = await imageStore.get(keyToLoad);
          if (activeRef) {
            const settings = await settingsStorage.load();
            const shouldUpload = refImageKey || settings.newConversationPerPrompt || !this.uploadedInCurrentSession;
            if (shouldUpload) {
              logger.info('Preparing product reference image for upload');
              refImageDataUrl = await blobToDataUrl(activeRef.blob);
              if (!refImageKey) {
                this.uploadedInCurrentSession = true;
              }
            } else {
              logger.info('Skipping reference image upload: already uploaded in current conversation thread');
            }
          }
        } catch (err) {
          logger.warn('Failed to load active reference image', { error: String(err) });
        }

        const payload: GenerateImagePayload = {
          itemId: '', // Set by caller
          prompt,
          newConversation: false,
          refImageDataUrl,
        };

        await sendToTab(this.geminiTabId!, MSG.GENERATE_IMAGE, payload);
      })().catch((err) => {
        this.clearPending();
        reject(new Error(`Failed to send generate request to Gemini tab: ${err}`));
      });
    });
  }

  handleImageGenerated(payload: ImageGeneratedPayload): void {
    if (this.pendingResolve) {
      this.pendingResolve({
        url: payload.imageUrl,
        width: payload.width,
        height: payload.height,
      });
      this.clearPending();
    } else if (this.onExternalCompleted) {
      this.onExternalCompleted(payload.itemId, payload.imageUrl);
    }
  }

  handleGenerationFailed(payload: GenerationFailedPayload): void {
    if (this.pendingReject) {
      this.pendingReject(new Error(payload.error));
      this.clearPending();
    } else if (this.onExternalFailed) {
      this.onExternalFailed(payload.itemId, payload.error);
    }
  }

  /** Check if the Gemini content script is still actively generating the item */
  async isCurrentlyGenerating(itemId: string): Promise<boolean> {
    if (!this.geminiTabId) return false;
    try {
      const response = await sendToTab<{
        pong: boolean;
        ready: boolean;
        activeGeneratingItemId: string | null;
      }>(this.geminiTabId, MSG.PING);
      return !!(response && response.activeGeneratingItemId === itemId);
    } catch {
      return false;
    }
  }

  getTabId(): number | null {
    return this.geminiTabId;
  }

  resetSession(): void {
    this.uploadedInCurrentSession = false;
  }

  private clearPending(): void {
    this.pendingResolve = null;
    this.pendingReject = null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
