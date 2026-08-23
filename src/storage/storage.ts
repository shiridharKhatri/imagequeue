import type { QueueData, ExtensionSettings } from '../shared/types';
import {
  STORAGE_KEY_QUEUE,
  STORAGE_KEY_SETTINGS,
  DEFAULT_SETTINGS,
} from '../shared/constants';

// ─── Queue Storage ─────────────────────────────────────────────

/**
 * Persistent queue storage backed by chrome.storage.local.
 * All methods are async and error-handled to prevent data loss.
 */
export class QueueStorage {
  /** Save the entire queue state */
  async save(queue: QueueData): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY_QUEUE]: JSON.parse(JSON.stringify(queue)),
      });
    } catch (err) {
      console.error('[QueueStorage] save failed:', err);
      throw new Error('Failed to save queue to storage');
    }
  }

  /** Load the queue state (returns null if not found) */
  async load(): Promise<QueueData | null> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_QUEUE);
      return result[STORAGE_KEY_QUEUE] ?? null;
    } catch (err) {
      console.error('[QueueStorage] load failed:', err);
      return null;
    }
  }

  /** Clear the queue from storage */
  async clear(): Promise<void> {
    try {
      await chrome.storage.local.remove(STORAGE_KEY_QUEUE);
    } catch (err) {
      console.error('[QueueStorage] clear failed:', err);
    }
  }
}

// ─── Settings Storage ──────────────────────────────────────────

/**
 * Persistent settings storage backed by chrome.storage.local.
 */
export class SettingsStorage {
  /** Load settings (returns defaults merged with any saved values) */
  async load(): Promise<ExtensionSettings> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
      const saved = result[STORAGE_KEY_SETTINGS];

      const merged = { ...DEFAULT_SETTINGS, ...saved };
      if (!merged.customBgRemovalUrl || !merged.customBgRemovalUrl.trim()) {
        merged.customBgRemovalUrl = 'https://imagetool.api.dailyworkreport.com';
      }
      return merged;
    } catch (err) {
      console.error('[SettingsStorage] load failed:', err);
      return { ...DEFAULT_SETTINGS, customBgRemovalUrl: 'https://imagetool.api.dailyworkreport.com' };
    }
  }

  /** Save settings */
  async save(settings: ExtensionSettings): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY_SETTINGS]: JSON.parse(JSON.stringify(settings)),
      });
    } catch (err) {
      console.error('[SettingsStorage] save failed:', err);
      throw new Error('Failed to save settings');
    }
  }

  /** Reset settings to defaults */
  async reset(): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY_SETTINGS]: { ...DEFAULT_SETTINGS },
      });
    } catch (err) {
      console.error('[SettingsStorage] reset failed:', err);
    }
  }
}

// ─── Singleton instances ───────────────────────────────────────

export const queueStorage = new QueueStorage();
export const settingsStorage = new SettingsStorage();
