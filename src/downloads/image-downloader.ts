import { logger } from '../shared/logger';

/**
 * Image download utilities using chrome.downloads API.
 */

export interface DownloadResult {
  success: boolean;
  downloadId?: number;
  error?: string;
}

/**
 * Download a blob as a file using chrome.downloads.
 */
export async function downloadBlob(
  blob: Blob,
  filename: string,
  saveAs: boolean = false
): Promise<DownloadResult> {
  try {
    const url = URL.createObjectURL(blob);

    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs,
    });

    // Clean up the object URL after a delay
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    logger.info('Download started', { filename, downloadId });
    return { success: true, downloadId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Download failed', { filename, error: errorMsg });
    return { success: false, error: errorMsg };
  }
}

/**
 * Download a file from a URL using chrome.downloads.
 */
export async function downloadUrl(
  url: string,
  filename: string,
  saveAs: boolean = false
): Promise<DownloadResult> {
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs,
    });

    logger.info('Download started', { filename, downloadId });
    return { success: true, downloadId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Download failed', { filename, error: errorMsg });
    return { success: false, error: errorMsg };
  }
}

/**
 * Wait for a download to complete.
 */
export function waitForDownload(
  downloadId: number,
  timeoutMs: number = 60_000
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;

      if (delta.state?.current === 'complete') {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(listener);
        resolve(true);
      } else if (delta.state?.current === 'interrupted') {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(listener);
        resolve(false);
      }
    };

    chrome.downloads.onChanged.addListener(listener);
  });
}
