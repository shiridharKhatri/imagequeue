import type { ImageGenerationProvider, GeneratedImage } from '../shared/types';
import { MSG, sendToTab } from '../shared/messages';
import type { GenerateImagePayload, ImageGeneratedPayload, GenerationFailedPayload } from '../shared/messages';
import {
  findChatGPTTab,
  ensureContentScript,
  checkChatGPTStatus,
  waitForTabLoad,
} from './tab-manager';
import { settingsStorage } from '../storage/storage';
import { logger } from '../shared/logger';
import { imageStore } from '../storage/image-store';

/**
 * ChatGPTProvider implements ImageGenerationProvider.
 *
 * It communicates with the content script to generate images
 * via the user's existing ChatGPT browser session.
 *
 * The queue manager only sees this as a generic provider.
 */
export class ChatGPTProvider implements ImageGenerationProvider {
  private chatgptTabId: number | null = null;
  private pendingResolve: ((result: GeneratedImage) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private uploadedInCurrentSession = false;

  /**
   * Check if ChatGPT is available and ready.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const settings = await settingsStorage.load();
      const tab = await findChatGPTTab(settings.chatgptDomain);

      if (!tab || !tab.id) {
        logger.warn('No ChatGPT tab found');
        return false;
      }

      this.chatgptTabId = tab.id;

      // Ensure content script is loaded
      const scriptReady = await ensureContentScript(tab.id);
      if (!scriptReady) {
        logger.warn('Content script not available');
        return false;
      }

      // Check ChatGPT status
      const status = await checkChatGPTStatus(tab.id);
      if (!status.loggedIn) {
        logger.warn('ChatGPT not logged in');
        return false;
      }

      return true;
    } catch (err) {
      logger.error('isAvailable check failed', { error: String(err) });
      return false;
    }
  }

  /**
   * Generate an image by sending a prompt to ChatGPT via the content script.
   *
   * This returns a Promise that resolves when the content script reports
   * IMAGE_GENERATED or rejects on GENERATION_FAILED / timeout.
   */
  async generateImage(prompt: string, refImageKey?: string): Promise<GeneratedImage> {
    if (!this.chatgptTabId) {
      const available = await this.isAvailable();
      if (!available) {
        throw new Error('ChatGPT tab not available');
      }
    }

    const settings = await settingsStorage.load();

    // If newConversation is requested, handle it in the background script to avoid context destruction
    if (settings.newConversationPerPrompt) {
      logger.info('Navigating ChatGPT tab to new conversation');
      await chrome.tabs.update(this.chatgptTabId!, { url: `https://${settings.chatgptDomain}/` });
      
      // Wait for tab to load
      await waitForTabLoad(this.chatgptTabId!);
      
      // Ensure content script is ready
      const ready = await ensureContentScript(this.chatgptTabId!);
      if (!ready) {
        throw new Error('Content script failed to initialize after navigation');
      }
    }

    return new Promise<GeneratedImage>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      (async () => {
        let refImageDataUrl: string | undefined = undefined;
        try {
          const keyToLoad = refImageKey || 'ref-image-active';
          const refImage = await imageStore.get(keyToLoad);
          if (refImage) {
            const settings = await settingsStorage.load();
            const shouldUpload = refImageKey || settings.newConversationPerPrompt || !this.uploadedInCurrentSession;
            if (shouldUpload) {
              logger.info('Preparing product reference image for upload');
              refImageDataUrl = await blobToDataUrl(refImage.blob);
              if (!refImageKey) {
                this.uploadedInCurrentSession = true;
              }
            } else {
              logger.info('Skipping reference image upload: already uploaded in current conversation thread');
            }
          }
        } catch (err) {
          logger.warn('Failed to load reference image', { error: String(err) });
        }

        const payload: GenerateImagePayload = {
          itemId: '', // Will be set by the caller
          prompt,
          newConversation: false, // Already handled in background script
          refImageDataUrl,
        };

        // Send generation command to content script
        await sendToTab(this.chatgptTabId!, MSG.GENERATE_IMAGE, payload);
      })().catch((err) => {
        this.clearPending();
        reject(new Error(`Failed to send to content script: ${err}`));
      });
    });
  }

  /**
   * Called by the service worker when it receives IMAGE_GENERATED from the content script.
   */
  handleImageGenerated(payload: ImageGeneratedPayload): void {
    if (this.pendingResolve) {
      this.pendingResolve({
        url: payload.imageUrl,
        width: payload.width,
        height: payload.height,
      });
      this.clearPending();
    }
  }

  /**
   * Called by the service worker when it receives GENERATION_FAILED from the content script.
   */
  handleGenerationFailed(payload: GenerationFailedPayload): void {
    if (this.pendingReject) {
      this.pendingReject(new Error(payload.error));
      this.clearPending();
    }
  }

  /** Get the current ChatGPT tab ID */
  getTabId(): number | null {
    return this.chatgptTabId;
  }

  /** Reset session upload state trackers */
  resetSession(): void {
    logger.info('Resetting provider session upload states');
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
