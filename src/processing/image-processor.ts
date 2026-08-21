import type { ProcessingOptions, ImageFormat } from '../shared/types';
import { logger } from '../shared/logger';

/**
 * Image processing utilities.
 *
 * These functions can run in any context with Canvas API access
 * (offscreen document, popup, content script — but NOT service worker).
 *
 * For use in the service worker, delegate to the offscreen document.
 */

/**
 * Process an image blob: convert format, resize, apply quality.
 *
 * @param inputBlob - The original image blob
 * @param options - Processing options (format, quality, maxWidth)
 * @returns Processed image blob
 */
export async function processImage(
  inputBlob: Blob,
  options: ProcessingOptions
): Promise<Blob> {
  const bitmap = await createImageBitmap(inputBlob);
  let targetWidth = bitmap.width;
  let targetHeight = bitmap.height;
  let cropX = 0, cropY = 0, cropW = bitmap.width, cropH = bitmap.height;
  let isCropped = false;

  const res = options.resolution || '0';
  if (res.includes('x')) {
    const [wStr, hStr] = res.split('x');
    const reqW = parseInt(wStr) || 0;
    const reqH = parseInt(hStr) || 0;
    if (reqW > 0 && reqH > 0) {
      if (options.containFit) {
        // Scale-to-fit: fit entire image inside target box, preserve aspect ratio
        const scale = Math.min(reqW / bitmap.width, reqH / bitmap.height);
        targetWidth = reqW;
        targetHeight = reqH;
        // We'll handle drawing with offset in the draw step
        cropW = bitmap.width;
        cropH = bitmap.height;
      } else {
        // Crop-to-fill: cover entire target box, crop excess
        targetWidth = reqW;
        targetHeight = reqH;
        isCropped = true;

        const inputRatio = bitmap.width / bitmap.height;
        const targetRatio = targetWidth / targetHeight;

        if (inputRatio > targetRatio) {
          cropW = bitmap.height * targetRatio;
          cropX = (bitmap.width - cropW) / 2;
        } else {
          cropH = bitmap.width / targetRatio;
          cropY = (bitmap.height - cropH) / 2;
        }
      }
    }
  } else {
    const maxWidth = parseInt(res) || 0;
    if (maxWidth > 0 && bitmap.width > maxWidth) {
      const scale = maxWidth / bitmap.width;
      targetWidth = maxWidth;
      targetHeight = Math.round(bitmap.height * scale);
    }
  }

  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d')!;
  
  if (options.containFit && res.includes('x')) {
    // Contain-fit: scale to fit inside target box, center on transparent canvas
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    const scale = Math.min(targetWidth / bitmap.width, targetHeight / bitmap.height);
    const drawW = Math.round(bitmap.width * scale);
    const drawH = Math.round(bitmap.height * scale);
    const offsetX = Math.round((targetWidth - drawW) / 2);
    const offsetY = Math.round((targetHeight - drawH) / 2);
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, offsetX, offsetY, drawW, drawH);
  } else if (isCropped) {
    ctx.drawImage(bitmap, cropX, cropY, cropW, cropH, 0, 0, targetWidth, targetHeight);
  } else {
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  }
  bitmap.close();

  const mimeType = formatToMime(options.format);
  const quality = options.quality / 100;

  let outputBlob: Blob;
  if (options.targetSizeKb && options.targetSizeKb > 0 && options.format !== 'png') {
    outputBlob = await compressToTargetSize(canvas, mimeType, options.targetSizeKb, quality);
  } else {
    outputBlob = await canvas.convertToBlob({
      type: mimeType,
      quality,
    });
  }

  return outputBlob;
}

/**
 * Remove white/near-white background from an image, making it transparent.
 * Uses a threshold-based approach on pixel data.
 * Always outputs PNG (required for transparency).
 */
export async function removeBackground(inputBlob: Blob, customBgRemovalUrl?: string): Promise<Blob> {
  try {
    let apiUrl = customBgRemovalUrl?.trim();

  if (!apiUrl) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const result = await chrome.storage.local.get('iq_settings');
        const settings = result['iq_settings'];
        apiUrl = (settings && settings.customBgRemovalUrl) ? settings.customBgRemovalUrl.trim() : 'http://localhost:8000';
      }
    } catch (err) {
      logger.error('Failed to query custom AI BG removal settings/API', { error: String(err) });
    }
  }

  if (!apiUrl) {
    apiUrl = 'http://localhost:8000';
  }
    
    if (apiUrl) {
      // Automatically append /remove-bg if only base URL/domain is provided
      if (!apiUrl.endsWith('/remove-bg') && !apiUrl.endsWith('/remove-bg/')) {
        apiUrl = apiUrl.replace(/\/$/, '') + '/remove-bg';
      }
      logger.info(`[image-processor] Using AI background removal API: ${apiUrl} (Blob size: ${inputBlob.size})`);
      const formData = new FormData();
      formData.append('file', inputBlob, 'image.png');
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: formData
      });
      
      if (response.ok) {
        const outBlob = await response.blob();
        logger.info(`[image-processor] AI Background removal succeeded. Output size: ${outBlob.size}`);
        return outBlob;
      } else {
        const errText = await response.text();
        logger.error(`[image-processor] Custom BG removal API returned error: ${response.status} - ${errText}`);
      }
    } else {
      logger.warn('[image-processor] AI Background removal API URL is empty.');
    }
  } catch (e) {
    logger.error('[image-processor] Failed to query custom AI BG removal settings/API', { error: String(e) });
  }

  // Warn the user and return the original blob (no local threshold background removal fallback)
  logger.warn('[image-processor] AI Background removal API failed or fallback returned original image.');
  return inputBlob;
}

/**
 * Crop transparent borders from a transparent image blob.
 * Shrinks canvas to fit only the non-transparent pixels.
 */
export async function cropTransparent(inputBlob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(inputBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const width = canvas.width;
  const height = canvas.height;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 5) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // If the image is completely transparent, return the original
  if (maxX === -1 || maxY === -1) {
    return inputBlob;
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  const croppedCanvas = new OffscreenCanvas(cropW, cropH);
  const croppedCtx = croppedCanvas.getContext('2d')!;
  
  // Draw the cropped region from the original canvas
  croppedCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

  return croppedCanvas.convertToBlob({ type: 'image/png' });
}

function getPixel(data: Uint8ClampedArray, x: number, y: number, width: number) {
  const idx = (y * width + x) * 4;
  return {
    r: data[idx],
    g: data[idx + 1],
    b: data[idx + 2]
  };
}

async function compressToTargetSize(
  canvas: OffscreenCanvas,
  mimeType: string,
  targetSizeKb: number,
  initialQuality: number = 0.9
): Promise<Blob> {
  const targetBytes = targetSizeKb * 1024;
  
  let q = initialQuality;
  let blob = await canvas.convertToBlob({ type: mimeType, quality: q });
  if (blob.size <= targetBytes) {
    return blob;
  }
  
  let low = 0.05;
  let high = initialQuality;
  let bestBlob = blob;
  
  for (let i = 0; i < 6; i++) {
    q = (low + high) / 2;
    blob = await canvas.convertToBlob({ type: mimeType, quality: q });
    
    if (blob.size <= targetBytes) {
      bestBlob = blob;
      low = q;
    } else {
      high = q;
    }
  }
  
  if (bestBlob.size > targetBytes) {
    return await canvas.convertToBlob({ type: mimeType, quality: 0.05 });
  }
  
  return bestBlob;
}

/**
 * Generate output filenames for a batch of images.
 */
export function generateFilenames(
  count: number,
  prefix: string,
  format: ImageFormat
): string[] {
  const ext = formatToExtension(format);
  return Array.from({ length: count }, (_, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `${prefix}-${num}.${ext}`;
  });
}

/**
 * Validate that a blob is a valid image.
 */
export async function validateImage(blob: Blob): Promise<boolean> {
  if (!blob || blob.size === 0) return false;

  try {
    const bitmap = await createImageBitmap(blob);
    const valid = bitmap.width > 0 && bitmap.height > 0;
    bitmap.close();
    return valid;
  } catch {
    return false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function formatToMime(format: ImageFormat): string {
  const map: Record<ImageFormat, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    avif: 'image/avif',
    tiff: 'image/tiff',
    def: 'image/webp', // Default fallback
  };
  return map[format] || 'image/webp';
}

function formatToExtension(format: ImageFormat): string {
  const map: Record<ImageFormat, string> = {
    png: 'png',
    jpg: 'jpg',
    webp: 'webp',
    avif: 'avif',
    tiff: 'tiff',
    def: 'webp', // Default fallback
  };
  return map[format] || 'webp';
}

export async function fillBackgroundColor(inputBlob: Blob, hexColor: string): Promise<Blob> {
  const bitmap = await createImageBitmap(inputBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  
  // Fill solid background
  ctx.fillStyle = hexColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Draw the original image on top
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // Return as PNG/WebP (using PNG to preserve lossless quality before final format compression)
  return canvas.convertToBlob({ type: 'image/png' });
}
