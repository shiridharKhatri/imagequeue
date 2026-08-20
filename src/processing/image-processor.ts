import type { ProcessingOptions, ImageFormat } from '../shared/types';

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
  
  if (isCropped) {
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
export async function removeBackground(inputBlob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(inputBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const width = canvas.width;
  const height = canvas.height;

  // 1. Detect background color by sampling corner pixels
  const samples = [
    getPixel(data, 0, 0, width),
    getPixel(data, width - 1, 0, width),
    getPixel(data, 0, height - 1, width),
    getPixel(data, width - 1, height - 1, width),
    getPixel(data, Math.floor(width / 2), 0, width),
    getPixel(data, 0, Math.floor(height / 2), width),
    getPixel(data, width - 1, Math.floor(height / 2), width),
    getPixel(data, Math.floor(width / 2), height - 1, width),
  ];

  // Calculate average RGB of the sampled edge/corner pixels
  let sumR = 0, sumG = 0, sumB = 0;
  for (const s of samples) {
    sumR += s.r;
    sumG += s.g;
    sumB += s.b;
  }
  const avgR = sumR / samples.length;
  const avgG = sumG / samples.length;
  const avgB = sumB / samples.length;
  const avgLuminance = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB;

  // Determine if we are removing a light background or a dark background
  const isLightBg = avgLuminance > 127;

  // 2. Perform edge-guided silhouette mask background removal.
  // This detects the outer boundaries of the product from the left and right edges,
  // creating a solid envelope that protects the white interior of the product (caps, labels, reflections).
  const maxDiff = isLightBg ? 30 : 25; // Stricter color distance threshold for edge detection
  const softDiff = isLightBg ? 60 : 50;

  const leftX = new Int32Array(height);
  const rightX = new Int32Array(height);

  function getPixelDist(x: number, y: number): number {
    const idx = (y * width + x) * 4;
    return Math.sqrt(
      Math.pow(data[idx] - avgR, 2) +
      Math.pow(data[idx + 1] - avgG, 2) +
      Math.pow(data[idx + 2] - avgB, 2)
    );
  }

  function isNonBg(x: number, y: number): boolean {
    return getPixelDist(x, y) > maxDiff;
  }

  // Find left and right boundaries for each row
  for (let y = 0; y < height; y++) {
    let foundLeft = false;
    for (let x = 0; x < width - 2; x++) {
      // Require 3 consecutive non-background pixels to filter out noise
      if (isNonBg(x, y) && isNonBg(x + 1, y) && isNonBg(x + 2, y)) {
        leftX[y] = x;
        foundLeft = true;
        break;
      }
    }
    if (!foundLeft) leftX[y] = width;

    let foundRight = false;
    for (let x = width - 1; x >= 2; x--) {
      if (isNonBg(x, y) && isNonBg(x - 1, y) && isNonBg(x - 2, y)) {
        rightX[y] = x;
        foundRight = true;
        break;
      }
    }
    if (!foundRight) rightX[y] = -1;
  }

  // Smooth boundaries using a sliding window to eliminate jagged edges
  const smoothLeft = new Int32Array(height);
  const smoothRight = new Int32Array(height);
  const windowSize = 5;
  const half = Math.floor(windowSize / 2);

  for (let y = 0; y < height; y++) {
    let sumL = 0;
    let sumR = 0;
    let count = 0;
    for (let dy = -half; dy <= half; dy++) {
      const ny = y + dy;
      if (ny >= 0 && ny < height) {
        if (leftX[ny] < width && rightX[ny] >= 0) {
          sumL += leftX[ny];
          sumR += rightX[ny];
          count++;
        }
      }
    }
    if (count > 0) {
      smoothLeft[y] = Math.round(sumL / count);
      smoothRight[y] = Math.round(sumR / count);
    } else {
      smoothLeft[y] = width;
      smoothRight[y] = -1;
    }
  }

  // Clear background outside the smoothed product boundaries
  for (let y = 0; y < height; y++) {
    const l = smoothLeft[y];
    const r = smoothRight[y];

    // Clear left background
    for (let x = 0; x < Math.min(l, width); x++) {
      data[(y * width + x) * 4 + 3] = 0;
    }

    // Clear right background
    for (let x = Math.max(r + 1, 0); x < width; x++) {
      data[(y * width + x) * 4 + 3] = 0;
    }

    // Apply soft anti-aliased edge transparency transitions on boundary pixels
    if (l < width) {
      const idx = (y * width + l) * 4;
      const d = getPixelDist(l, y);
      if (d <= softDiff) {
        const ratio = (d - maxDiff) / (softDiff - maxDiff);
        data[idx + 3] = Math.max(0, Math.min(255, Math.round(255 * ratio)));
      }
    }
    if (r >= 0 && r < width) {
      const idx = (y * width + r) * 4;
      const d = getPixelDist(r, y);
      if (d <= softDiff) {
        const ratio = (d - maxDiff) / (softDiff - maxDiff);
        data[idx + 3] = Math.max(0, Math.min(255, Math.round(255 * ratio)));
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
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
