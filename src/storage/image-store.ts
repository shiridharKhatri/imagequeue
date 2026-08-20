/**
 * Image blob storage using IndexedDB.
 *
 * IndexedDB is used instead of chrome.storage.local because:
 * 1. No size limit per entry (chrome.storage has ~10MB total by default)
 * 2. Efficient binary blob storage (no base64 encoding overhead)
 * 3. Can store dozens of high-res images without issue
 *
 * This module runs in any context that has IndexedDB access:
 * - Offscreen document (primary)
 * - Content script (fallback)
 * - Popup (for reading images during batch processing)
 */

const DB_NAME = 'ImageQueueDB';
const DB_VERSION = 1;
const STORE_NAME = 'images';

interface StoredImage {
  id: string;
  blob: Blob;
  mimeType: string;
  width?: number;
  height?: number;
  localFilename?: string;
  createdAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class ImageStore {
  /** Store an image blob */
  async store(id: string, blob: Blob, width?: number, height?: number, localFilename?: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: StoredImage = {
        id,
        blob,
        mimeType: blob.type,
        width,
        height,
        localFilename,
        createdAt: Date.now(),
      };
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  /** Retrieve an image blob by ID */
  async get(id: string): Promise<StoredImage | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  /** Get all stored images */
  async getAll(): Promise<StoredImage[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  /** Delete a specific image */
  async delete(id: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  /** Clear all stored images */
  async clear(): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  /** Get approximate storage usage */
  async getUsage(): Promise<number> {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        return estimate.usage ?? 0;
      }
    } catch {
      // Not available in all contexts
    }
    return 0;
  }
}

/** Singleton image store */
export const imageStore = new ImageStore();
