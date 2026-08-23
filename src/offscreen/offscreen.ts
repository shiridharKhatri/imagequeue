import JSZip from 'jszip';
import type { ProcessingOptions, ImageFormat } from '../shared/types';
import { imageStore } from '../storage/image-store';
import { removeBackground, cropTransparent, fillBackgroundColor } from '../processing/image-processor';
import { logger } from '../shared/logger';

/**
 * Offscreen document script.
 *
 * Handles image processing (format conversion, resize) and ZIP creation
 * using the Canvas API, which is not available in service workers.
 */

interface ProcessImagesRequest {
  items: { id: string; prompt: string }[];
  options: ProcessingOptions;
}

interface BuildZipRequest {
  items: { id: string; prompt: string }[];
  options?: ProcessingOptions;
}

interface ProcessSingleImageRequest {
  itemId: string;
  options: ProcessingOptions;
  prompt: string;
}

// ─── Message Handler ───────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: { type: string; payload?: unknown }, _sender, sendResponse) => {
    switch (message.type) {
      case 'OFFSCREEN_PROCESS_IMAGES': {
        const req = message.payload as ProcessImagesRequest;
        handleProcessImages(req)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ error: String(err) }));
        return true;
      }

      case 'OFFSCREEN_BUILD_ZIP': {
        const req = message.payload as BuildZipRequest;
        handleBuildZip(req)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ error: String(err) }));
        return true;
      }

      case 'OFFSCREEN_PROCESS_SINGLE_IMAGE': {
        const req = message.payload as ProcessSingleImageRequest;
        handleProcessSingleImage(req)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ error: String(err) }));
        return true;
      }

      default:
        return false;
    }
  }
);

// ─── Image Processing ──────────────────────────────────────────

async function handleProcessImages(
  req: ProcessImagesRequest
): Promise<{ zipBlob: Blob; fileCount: number }> {
  const { items, options } = req;
  const zip = new JSZip();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const stored = await imageStore.get(item.id);
    if (!stored) continue;

    const customMeta = options.customMetadata?.[item.id];
    const itemMetadata = {
      title: customMeta?.title ?? options.metadata?.title ?? '',
      author: customMeta?.author ?? options.metadata?.author ?? '',
      description: customMeta?.description ?? options.metadata?.description ?? item.prompt,
      make: customMeta?.make ?? options.metadata?.make ?? undefined,
      model: customMeta?.model ?? options.metadata?.model ?? undefined,
      lensModel: customMeta?.lensModel ?? options.metadata?.lensModel ?? undefined,
      software: customMeta?.software ?? options.metadata?.software ?? undefined,
      country: customMeta?.country ?? options.metadata?.country ?? undefined,
      state: customMeta?.state ?? options.metadata?.state ?? undefined,
      city: customMeta?.city ?? options.metadata?.city ?? undefined,
      subLocation: customMeta?.subLocation ?? options.metadata?.subLocation ?? undefined,
      gpsLatitude: customMeta?.gpsLatitude ?? options.metadata?.gpsLatitude ?? undefined,
      gpsLongitude: customMeta?.gpsLongitude ?? options.metadata?.gpsLongitude ?? undefined,
      dateTimeOriginal: sanitizeDateTimeString(customMeta?.dateTimeOriginal ?? options.metadata?.dateTimeOriginal),
    };

    // Check card-specific BG remove, Crop, and Background Color
    const isBgRemove = options.bgRemove?.[item.id] || false;
    const isCrop = options.crop?.[item.id] || false;
    const isBgColor = options.bgColorEnable?.[item.id] || false;
    const bgColor = options.bgColorValue?.[item.id] || '#ffffff';

    logger.info(`[offscreen] handleProcessImages: Item ${i + 1} (${item.id}): isBgRemove=${isBgRemove}, isCrop=${isCrop}, isBgColor=${isBgColor}`);

    const itemResolution = (options.customResolutions && options.customResolutions[item.id]) || options.resolution;

    // Determine target format
    let fmt = (isBgRemove || isCrop) && !isBgColor ? 'png' : options.format;
    if (fmt === 'def') {
      fmt = getExtensionFromMime(stored.blob.type) as ImageFormat;
    }

    let processed = stored.blob;

    if (options.imageProcessingMode === 'api') {
      processed = await processImage(processed, {
        ...options,
        format: fmt,
        resolution: itemResolution,
        metadata: itemMetadata,
        containFit: isBgRemove || isCrop,
        bgRemoveFlag: isBgRemove,
        cropFlag: isCrop,
        bgColorEnableFlag: isBgColor,
        bgColorValueFlag: bgColor,
      });
    } else {
      if (isBgRemove) {
        processed = await removeBackground(processed, options.customBgRemovalUrl);
      }
      if (isCrop) {
        processed = await cropTransparent(processed);
      }
      if (isBgColor) {
        processed = await fillBackgroundColor(processed, bgColor);
      }

      processed = await processImage(processed, {
        ...options,
        format: fmt,
        resolution: itemResolution,
        metadata: itemMetadata,
        containFit: isBgRemove || isCrop,
      });
    }

    const ext = formatToExtension(fmt);

    // Choose custom name if specified, otherwise index-based
    let filename = '';
    if (options.customFilenames && options.customFilenames[item.id]) {
      filename = `${options.customFilenames[item.id]}.${ext}`;
    } else {
      const prefix = options.filenamePrefix || 'image';
      filename = `${prefix}-${String(i + 1).padStart(2, '0')}.${ext}`;
    }

    zip.file(filename, processed);
  }

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  await logger.flush();
  return { zipBlob, fileCount: items.length };
}

async function handleBuildZip(
  req: BuildZipRequest
): Promise<{ blobUrl: string; filename: string }> {
  const { items, options } = req;
  logger.info(`[offscreen] handleBuildZip started. Items count: ${items.length}, Options defined: ${!!options}`);
  if (options) {
    logger.info(`[offscreen] Options payload:`, {
      format: options.format,
      resolution: options.resolution,
      bgRemoveKeys: Object.keys(options.bgRemove || {}),
      cropKeys: Object.keys(options.crop || {}),
    });
  }
  const zip = new JSZip();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const stored = await imageStore.get(item.id);
    if (!stored) continue;

    let blob = stored.blob;
    let ext = getExtensionFromMime(stored.mimeType);

    if (options) {
      const customMeta = options.customMetadata?.[item.id];
      const itemMetadata = {
        title: customMeta?.title ?? options.metadata?.title ?? '',
        author: customMeta?.author ?? options.metadata?.author ?? '',
        description: customMeta?.description ?? options.metadata?.description ?? item.prompt,
        make: customMeta?.make ?? options.metadata?.make ?? undefined,
        model: customMeta?.model ?? options.metadata?.model ?? undefined,
        lensModel: customMeta?.lensModel ?? options.metadata?.lensModel ?? undefined,
        software: customMeta?.software ?? options.metadata?.software ?? undefined,
        country: customMeta?.country ?? options.metadata?.country ?? undefined,
        state: customMeta?.state ?? options.metadata?.state ?? undefined,
        city: customMeta?.city ?? options.metadata?.city ?? undefined,
        subLocation: customMeta?.subLocation ?? options.metadata?.subLocation ?? undefined,
        gpsLatitude: customMeta?.gpsLatitude ?? options.metadata?.gpsLatitude ?? undefined,
        gpsLongitude: customMeta?.gpsLongitude ?? options.metadata?.gpsLongitude ?? undefined,
        dateTimeOriginal: sanitizeDateTimeString(customMeta?.dateTimeOriginal ?? options.metadata?.dateTimeOriginal),
      };

      // Check card-specific BG remove, Crop, and Background Color
      const isBgRemove = options.bgRemove?.[item.id] || false;
      const isCrop = options.crop?.[item.id] || false;
      const isBgColor = options.bgColorEnable?.[item.id] || false;
      const bgColor = options.bgColorValue?.[item.id] || '#ffffff';

      logger.info(`[offscreen] Item ${i + 1} (${item.id}): isBgRemove=${isBgRemove}, isCrop=${isCrop}, isBgColor=${isBgColor}`);

      const itemResolution = (options.customResolutions && options.customResolutions[item.id]) || options.resolution;

      // Determine target format
      let fmt = (isBgRemove || isCrop) && !isBgColor ? 'png' : options.format;
      if (fmt === 'def') {
        fmt = getExtensionFromMime(stored.blob.type) as ImageFormat;
      }

      blob = stored.blob;

      if (options.imageProcessingMode === 'api') {
        blob = await processImage(blob, {
          ...options,
          format: fmt,
          resolution: itemResolution,
          metadata: itemMetadata,
          containFit: isBgRemove || isCrop,
          bgRemoveFlag: isBgRemove,
          cropFlag: isCrop,
          bgColorEnableFlag: isBgColor,
          bgColorValueFlag: bgColor,
        });
      } else {
        if (isBgRemove) {
          blob = await removeBackground(blob, options?.customBgRemovalUrl);
        }
        if (isCrop) {
          blob = await cropTransparent(blob);
        }
        if (isBgColor) {
          blob = await fillBackgroundColor(blob, bgColor);
        }

        blob = await processImage(blob, {
          ...options,
          format: fmt,
          resolution: itemResolution,
          metadata: itemMetadata,
          containFit: isBgRemove || isCrop,
        });
      }

      ext = formatToExtension(fmt);
    }

    let filename = '';
    if (options?.customFilenames && options.customFilenames[item.id]) {
      filename = `${options.customFilenames[item.id]}.${ext}`;
    } else {
      const prefix = options?.filenamePrefix || 'image';
      filename = `${prefix}-${String(i + 1).padStart(2, '0')}.${ext}`;
    }

    zip.file(filename, blob);
  }

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const blobUrl = URL.createObjectURL(zipBlob);
  const filename = `${options?.filenamePrefix || 'image'}-images.zip`;

  await logger.flush();
  return { blobUrl, filename };
}

async function handleProcessSingleImage(
  req: ProcessSingleImageRequest
): Promise<{ blobUrl: string; filename: string }> {
  const { itemId, options, prompt } = req;
  const stored = await imageStore.get(itemId);
  if (!stored) throw new Error('Image not found in store');

  const customMeta = options.customMetadata?.[itemId];
  const itemMetadata = {
    title: customMeta?.title ?? options.metadata?.title ?? '',
    author: customMeta?.author ?? options.metadata?.author ?? '',
    description: customMeta?.description ?? options.metadata?.description ?? prompt,
    make: customMeta?.make ?? options.metadata?.make ?? undefined,
    model: customMeta?.model ?? options.metadata?.model ?? undefined,
    lensModel: customMeta?.lensModel ?? options.metadata?.lensModel ?? undefined,
    software: customMeta?.software ?? options.metadata?.software ?? undefined,
    country: customMeta?.country ?? options.metadata?.country ?? undefined,
    state: customMeta?.state ?? options.metadata?.state ?? undefined,
    city: customMeta?.city ?? options.metadata?.city ?? undefined,
    subLocation: customMeta?.subLocation ?? options.metadata?.subLocation ?? undefined,
    gpsLatitude: customMeta?.gpsLatitude ?? options.metadata?.gpsLatitude ?? undefined,
    gpsLongitude: customMeta?.gpsLongitude ?? options.metadata?.gpsLongitude ?? undefined,
    dateTimeOriginal: sanitizeDateTimeString(customMeta?.dateTimeOriginal ?? options.metadata?.dateTimeOriginal),
  };

  // Check card-specific BG remove, Crop, and Background Color
  const isBgRemove = options.bgRemove?.[itemId] || false;
  const isCrop = options.crop?.[itemId] || false;
  const isBgColor = options.bgColorEnable?.[itemId] || false;
  const bgColor = options.bgColorValue?.[itemId] || '#ffffff';

  logger.info(`[offscreen] handleProcessSingleImage: isBgRemove=${isBgRemove}, isCrop=${isCrop}, isBgColor=${isBgColor}`);

  const itemResolution = (options.customResolutions && options.customResolutions[itemId]) || options.resolution;

  // Determine target format
  let fmt = (isBgRemove || isCrop) && !isBgColor ? 'png' : options.format;
  if (fmt === 'def') {
    fmt = getExtensionFromMime(stored.blob.type) as ImageFormat;
  }

  let processed = stored.blob;

  if (options.imageProcessingMode === 'api') {
    processed = await processImage(processed, {
      ...options,
      format: fmt,
      resolution: itemResolution,
      metadata: itemMetadata,
      containFit: isBgRemove || isCrop,
      bgRemoveFlag: isBgRemove,
      cropFlag: isCrop,
      bgColorEnableFlag: isBgColor,
      bgColorValueFlag: bgColor,
    });
  } else {
    if (isBgRemove) {
      processed = await removeBackground(processed, options.customBgRemovalUrl);
    }
    if (isCrop) {
      processed = await cropTransparent(processed);
    }
    if (isBgColor) {
      processed = await fillBackgroundColor(processed, bgColor);
    }

    processed = await processImage(processed, {
      ...options,
      format: fmt,
      resolution: itemResolution,
      metadata: itemMetadata,
      containFit: isBgRemove || isCrop,
    });
  }

  const ext = formatToExtension(fmt);

  let filename = '';
  if (options.customFilenames && options.customFilenames[itemId]) {
    filename = `${options.customFilenames[itemId]}.${ext}`;
  } else {
    filename = `${options.filenamePrefix || 'image'}.${ext}`;
  }

  const blobUrl = URL.createObjectURL(processed);
  await logger.flush();
  return { blobUrl, filename };
}

/**
 * Process a single image: convert format, resize, apply quality.
 */
async function processImage(
  inputBlob: Blob,
  options: ProcessingOptions
): Promise<Blob> {
  if (options.imageProcessingMode === 'api') {
    return processImageViaApi(inputBlob, options);
  }
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

  const rotateDeg = options.adjustments?.rotate || 0;
  const isSwapped = rotateDeg === 90 || rotateDeg === 270;
  const canvasWidth = isSwapped ? targetHeight : targetWidth;
  const canvasHeight = isSwapped ? targetWidth : targetHeight;

  const canvas = document.getElementById('processing-canvas') as HTMLCanvasElement;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  if (options.adjustments) {
    const adj = options.adjustments;
    const filterParts: string[] = [];
    if (adj.brightness !== 100) filterParts.push(`brightness(${adj.brightness}%)`);
    if (adj.contrast !== 100) filterParts.push(`contrast(${adj.contrast}%)`);
    if (adj.saturation !== 100) filterParts.push(`saturate(${adj.saturation}%)`);
    if (adj.grayscale > 0) filterParts.push(`grayscale(${adj.grayscale}%)`);

    if (filterParts.length > 0) {
      ctx.filter = filterParts.join(' ');
    } else {
      ctx.filter = 'none';
    }
  } else {
    ctx.filter = 'none';
  }

  ctx.save();
  ctx.translate(canvasWidth / 2, canvasHeight / 2);

  const flipH = options.adjustments?.flipH ? -1 : 1;
  const flipV = options.adjustments?.flipV ? -1 : 1;
  ctx.scale(flipH, flipV);

  if (rotateDeg !== 0) {
    ctx.rotate((rotateDeg * Math.PI) / 180);
  }

  if (isCropped) {
    ctx.drawImage(bitmap, cropX, cropY, cropW, cropH, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
  } else {
    ctx.drawImage(bitmap, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
  }
  ctx.restore();
  bitmap.close();

  // Convert to target format
  let targetFormat = options.format;
  if (targetFormat === 'def') {
    targetFormat = getExtensionFromMime(inputBlob.type) as ImageFormat;
  }

  let rawBlob: Blob;
  if (targetFormat === 'tiff') {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    const tiffBytes = encodeTiff(canvasWidth, canvasHeight, new Uint8Array(imageData.data.buffer), options.metadata);
    rawBlob = new Blob([tiffBytes.buffer as any], { type: 'image/tiff' });
    return rawBlob; // Metadata is already injected inside TIFF encoder!
  }

  const mimeType = formatToMime(targetFormat);
  const quality = options.quality / 100;

  if (options.targetSizeKb && options.targetSizeKb > 0) {
    rawBlob = await compressToTargetSize(canvas, mimeType, options.targetSizeKb, quality);
  } else {
    rawBlob = await canvasToBlob(canvas, mimeType, quality);
  }

  // Inject EXIF or PNG tEXt metadata
  return injectMetadata(rawBlob, targetFormat, options.metadata, canvasWidth, canvasHeight);
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      },
      mimeType,
      quality
    );
  });
}

async function compressToTargetSize(
  canvas: HTMLCanvasElement,
  mimeType: string,
  targetSizeKb: number,
  initialQuality: number = 0.9
): Promise<Blob> {
  const targetBytes = targetSizeKb * 1024;

  if (mimeType === 'image/png') {
    let blob = await canvasToBlob(canvas, 'image/png');
    if (blob.size <= targetBytes) {
      return blob;
    }

    let low = 0.1;
    let high = 1.0;
    let bestBlob = blob;

    for (let i = 0; i < 6; i++) {
      const scale = (low + high) / 2;
      const w = Math.max(1, Math.round(canvas.width * scale));
      const h = Math.max(1, Math.round(canvas.height * scale));
      
      const scaledCanvas = document.createElement('canvas');
      scaledCanvas.width = w;
      scaledCanvas.height = h;
      const scaledCtx = scaledCanvas.getContext('2d')!;
      scaledCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, w, h);

      const scaledBlob = await canvasToBlob(scaledCanvas, 'image/png');
      if (scaledBlob.size <= targetBytes) {
        bestBlob = scaledBlob;
        low = scale;
      } else {
        high = scale;
      }
    }

    if (bestBlob.size > targetBytes) {
      const w = Math.max(1, Math.round(canvas.width * 0.1));
      const h = Math.max(1, Math.round(canvas.height * 0.1));
      const scaledCanvas = document.createElement('canvas');
      scaledCanvas.width = w;
      scaledCanvas.height = h;
      const scaledCtx = scaledCanvas.getContext('2d')!;
      scaledCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, w, h);
      return await canvasToBlob(scaledCanvas, 'image/png');
    }
    return bestBlob;
  }

  // Try with initial quality first
  let q = initialQuality;
  let blob = await canvasToBlob(canvas, mimeType, q);
  if (blob.size <= targetBytes) {
    return blob;
  }

  // Binary search for quality setting
  let low = 0.05;
  let high = initialQuality;
  let bestBlob = blob;

  for (let i = 0; i < 6; i++) {
    q = (low + high) / 2;
    blob = await canvasToBlob(canvas, mimeType, q);

    if (blob.size <= targetBytes) {
      bestBlob = blob;
      low = q; // Quality is acceptable, see if we can get larger
    } else {
      high = q; // File is too large, decrease quality
    }
  }

  // Final fallback: if even the best found setting is too large, use lowest quality
  if (bestBlob.size > targetBytes) {
    return await canvasToBlob(canvas, mimeType, 0.05);
  }

  return bestBlob;
}

// ─── Metadata Injection ────────────────────────────────────────

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[i] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngTextChunk(keyword: string, text: string): Uint8Array {
  const keywordBytes = new TextEncoder().encode(keyword);
  const textBytes = new TextEncoder().encode(text);

  const chunkLength = keywordBytes.length + 1 + textBytes.length;
  const chunk = new Uint8Array(4 + 4 + chunkLength + 4);

  new DataView(chunk.buffer).setUint32(0, chunkLength, false);
  chunk.set(new TextEncoder().encode('tEXt'), 4);
  chunk.set(keywordBytes, 8);
  chunk[8 + keywordBytes.length] = 0;
  chunk.set(textBytes, 8 + keywordBytes.length + 1);

  const crcInput = chunk.subarray(4, 4 + 4 + chunkLength);
  const crc = crc32(crcInput);
  new DataView(chunk.buffer).setUint32(4 + 4 + chunkLength, crc, false);

  return chunk;
}

function buildGpsIfd(latStr: string, lonStr: string, gpsIfdOffset: number): Uint8Array {
  const latVal = parseFloat(latStr);
  const lonVal = parseFloat(lonStr);

  const latRef = latVal >= 0 ? 'N' : 'S';
  const lonRef = lonVal >= 0 ? 'E' : 'W';

  const absLat = Math.abs(latVal);
  const absLon = Math.abs(lonVal);

  const parseDms = (val: number) => {
    const d = Math.floor(val);
    const minFloat = (val - d) * 60;
    const m = Math.floor(minFloat);
    const s = Math.round((minFloat - m) * 60 * 100);
    return { d, m, s };
  };

  const latDms = parseDms(absLat);
  const lonDms = parseDms(absLon);

  const gpsBlock = new Uint8Array(102);
  const view = new DataView(gpsBlock.buffer);

  view.setUint16(0, 4, true);

  const latRatsOffset = gpsIfdOffset + 54;
  const lonRatsOffset = gpsIfdOffset + 54 + 24;

  // GPSLatitudeRef
  view.setUint16(2, 0x0001, true);
  view.setUint16(4, 2, true);
  view.setUint32(6, 2, true);
  view.setUint8(10, latRef.charCodeAt(0));
  view.setUint8(11, 0);

  // GPSLatitude
  view.setUint16(14, 0x0002, true);
  view.setUint16(16, 5, true);
  view.setUint32(18, 3, true);
  view.setUint32(22, latRatsOffset, true);

  // GPSLongitudeRef
  view.setUint16(26, 0x0003, true);
  view.setUint16(28, 2, true);
  view.setUint32(30, 2, true);
  view.setUint8(34, lonRef.charCodeAt(0));
  view.setUint8(35, 0);

  // GPSLongitude
  view.setUint16(38, 0x0004, true);
  view.setUint16(40, 5, true);
  view.setUint32(42, 3, true);
  view.setUint32(46, lonRatsOffset, true);

  view.setUint32(50, 0, true);

  // Latitude Degrees, Minutes, Seconds (denom: 1, 1, 100)
  view.setUint32(54, latDms.d, true);
  view.setUint32(58, 1, true);
  view.setUint32(62, latDms.m, true);
  view.setUint32(66, 1, true);
  view.setUint32(70, latDms.s, true);
  view.setUint32(74, 100, true);

  // Longitude Degrees, Minutes, Seconds (denom: 1, 1, 100)
  view.setUint32(78, lonDms.d, true);
  view.setUint32(82, 1, true);
  view.setUint32(86, lonDms.m, true);
  view.setUint32(90, 1, true);
  view.setUint32(94, lonDms.s, true);
  view.setUint32(98, 100, true);

  return gpsBlock;
}

function createExifApp1(metadata: {
  title?: string;
  author?: string;
  description?: string;
  make?: string;
  model?: string;
  lensModel?: string;
  software?: string;
  country?: string;
  state?: string;
  city?: string;
  subLocation?: string;
  gpsLatitude?: string;
  gpsLongitude?: string;
  dateTimeOriginal?: string;
}): Uint8Array {
  const entries: { tag: number; type: number; count: number; value: Uint8Array }[] = [];

  const addAsciiEntry = (tag: number, val?: string) => {
    if (val) {
      const bytes = new TextEncoder().encode(val + '\0');
      entries.push({ tag, type: 2, count: bytes.length, value: bytes });
    }
  };

  addAsciiEntry(0x013b, metadata.author);
  addAsciiEntry(0x9c9b, metadata.title);
  addAsciiEntry(0x010f, metadata.make);
  addAsciiEntry(0x0110, metadata.model);
  addAsciiEntry(0x0131, metadata.software);

  if (metadata.dateTimeOriginal) {
    addAsciiEntry(0x0132, metadata.dateTimeOriginal); // Standard TIFF DateTime
    addAsciiEntry(0x9003, metadata.dateTimeOriginal); // EXIF DateTimeOriginal
  }

  addAsciiEntry(0xa434, metadata.lensModel);

  // Geographic text tags (standard IPTC/XMP counterparts can also use these)
  addAsciiEntry(0x011c, metadata.country);
  addAsciiEntry(0x011d, metadata.state);
  addAsciiEntry(0x011e, metadata.city);
  addAsciiEntry(0x011f, metadata.subLocation);

  const tiffHeaderSize = 8;
  const hasGps = metadata.gpsLatitude && metadata.gpsLongitude;
  const ifd0EntryCount = entries.length + (hasGps ? 1 : 0);
  const ifd0Size = 2 + (ifd0EntryCount * 12) + 4;

  let offset = tiffHeaderSize + ifd0Size;
  const valueBytesList: Uint8Array[] = [];
  const entryOffsets: number[] = [];

  for (const entry of entries) {
    valueBytesList.push(entry.value);
    entryOffsets.push(offset);
    offset += entry.value.length;
  }

  let gpsBlock: Uint8Array | null = null;
  let gpsOffset = 0;
  if (hasGps) {
    gpsOffset = offset;
    gpsBlock = buildGpsIfd(metadata.gpsLatitude!, metadata.gpsLongitude!, gpsOffset);
    valueBytesList.push(gpsBlock);
    entryOffsets.push(gpsOffset);
    offset += gpsBlock.length;

    const gpsInfoOffsetBytes = new Uint8Array(4);
    new DataView(gpsInfoOffsetBytes.buffer).setUint32(0, gpsOffset, true);
    entries.push({ tag: 0x8825, type: 4, count: 1, value: gpsInfoOffsetBytes });
  }

  // Sort by tag ID ascending
  entries.sort((a, b) => a.tag - b.tag);

  const exifHeader = new TextEncoder().encode('Exif\0\0');
  const app1Size = 2 + exifHeader.length + offset;
  const block = new Uint8Array(2 + app1Size);

  block[0] = 0xff;
  block[1] = 0xe1;
  new DataView(block.buffer).setUint16(2, app1Size, false);
  block.set(exifHeader, 4);

  const tiffStart = 4 + exifHeader.length;
  const view = new DataView(block.buffer, tiffStart, offset);

  view.setUint16(0, 0x4949, true); // Byte order: II (little endian)
  view.setUint16(2, 0x002a, true); // TIFF magic number
  view.setUint32(4, 8, true);      // Offset to 0th IFD

  view.setUint16(8, ifd0EntryCount, true);

  let entryOffset = 10;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const bytes = entry.value;

    // Find the offset for this entry's value
    let valOffset = 0;
    if (entry.tag === 0x8825) {
      valOffset = gpsOffset;
    } else {
      const idx = entries.filter(e => e.tag !== 0x8825).indexOf(entry);
      valOffset = entryOffsets[idx];
    }

    view.setUint16(entryOffset, entry.tag, true);
    view.setUint16(entryOffset + 2, entry.type, true);
    view.setUint32(entryOffset + 4, entry.count, true);

    if (bytes.length <= 4) {
      for (let j = 0; j < bytes.length; j++) {
        view.setUint8(entryOffset + 8 + j, bytes[j]);
      }
    } else {
      view.setUint32(entryOffset + 8, valOffset, true);
    }
    entryOffset += 12;
  }
  view.setUint32(entryOffset, 0, true); // End of IFD0

  // Write all value segments
  let valIdx = 0;
  for (const entry of entries) {
    if (entry.tag === 0x8825) continue;
    block.set(entry.value, tiffStart + entryOffsets[valIdx]);
    valIdx++;
  }
  if (gpsBlock) {
    block.set(gpsBlock, tiffStart + gpsOffset);
  }

  return block;
}

async function injectMetadata(
  blob: Blob,
  format: ImageFormat,
  metadata?: {
    title?: string;
    author?: string;
    description?: string;
    make?: string;
    model?: string;
    lensModel?: string;
    software?: string;
    country?: string;
    state?: string;
    city?: string;
    subLocation?: string;
    gpsLatitude?: string;
    gpsLongitude?: string;
    dateTimeOriginal?: string;
  },
  width?: number,
  height?: number
): Promise<Blob> {
  if (!metadata) {
    return blob;
  }

  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  if (format === 'png') {
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
      return blob; // Invalid PNG
    }

    const chunks: Uint8Array[] = [];
    if (metadata.title) chunks.push(createPngTextChunk('Title', metadata.title));
    if (metadata.author) chunks.push(createPngTextChunk('Author', metadata.author));
    if (metadata.description) chunks.push(createPngTextChunk('Description', metadata.description));
    if (metadata.make) chunks.push(createPngTextChunk('Make', metadata.make));
    if (metadata.model) chunks.push(createPngTextChunk('Model', metadata.model));
    if (metadata.lensModel) chunks.push(createPngTextChunk('LensModel', metadata.lensModel));
    if (metadata.software) chunks.push(createPngTextChunk('Software', metadata.software));
    if (metadata.country) chunks.push(createPngTextChunk('Country', metadata.country));
    if (metadata.state) chunks.push(createPngTextChunk('State', metadata.state));
    if (metadata.city) chunks.push(createPngTextChunk('City', metadata.city));
    if (metadata.subLocation) chunks.push(createPngTextChunk('SubLocation', metadata.subLocation));
    if (metadata.gpsLatitude) chunks.push(createPngTextChunk('GPSLatitude', metadata.gpsLatitude));
    if (metadata.gpsLongitude) chunks.push(createPngTextChunk('GPSLongitude', metadata.gpsLongitude));
    if (metadata.dateTimeOriginal) chunks.push(createPngTextChunk('DateTimeOriginal', metadata.dateTimeOriginal));

    if (chunks.length === 0) return blob;

    const totalNewLength = bytes.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const newBytes = new Uint8Array(totalNewLength);

    // Signature + IHDR = 33 bytes
    newBytes.set(bytes.subarray(0, 33), 0);

    let currentOffset = 33;
    for (const chunk of chunks) {
      newBytes.set(chunk, currentOffset);
      currentOffset += chunk.length;
    }

    newBytes.set(bytes.subarray(33), currentOffset);
    return new Blob([newBytes], { type: 'image/png' });
  }

  if (format === 'jpg') {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      return blob; // Invalid JPEG
    }

    const app1Block = createExifApp1(metadata);
    if (app1Block.length === 0) return blob;

    // Find correct insert position (after SOI and optionally after JFIF APP0)
    let insertOffset = 2;
    if (bytes[2] === 0xff && bytes[3] === 0xe0) {
      const app0Length = (bytes[4] << 8) | bytes[5];
      insertOffset = 2 + 2 + app0Length; // SOI (2) + marker (2) + length (app0Length)
    }

    const newBytes = new Uint8Array(bytes.length + app1Block.length);
    newBytes.set(bytes.subarray(0, insertOffset), 0);
    newBytes.set(app1Block, insertOffset);
    newBytes.set(bytes.subarray(insertOffset), insertOffset + app1Block.length);

    return new Blob([newBytes], { type: 'image/jpeg' });
  }

  if (format === 'webp') {
    if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46 || // RIFF
      bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) { // WEBP
      return blob; // Invalid WebP
    }

    let imgWidth = width;
    let imgHeight = height;
    if (!imgWidth || !imgHeight) {
      try {
        const bitmap = await createImageBitmap(blob);
        imgWidth = bitmap.width;
        imgHeight = bitmap.height;
        bitmap.close();
      } catch (err) {
        chrome.runtime.sendMessage({
          type: 'LOG_ENTRY',
          payload: {
            level: 'ERROR',
            message: `[injectMetadata] Failed to decode WebP dimensions: ${err}`
          }
        }).catch(() => {});
        return blob;
      }
    }

    const app1Block = createExifApp1(metadata);
    if (app1Block.length === 0) return blob;

    // TIFF starts at offset 10 of app1Block (after APP1 marker + size + Exif\0\0 header)
    const tiffBytes = app1Block.subarray(10);
    const exifChunkSize = tiffBytes.length;

    // Create EXIF chunk
    const exifChunk = new Uint8Array(8 + exifChunkSize + (exifChunkSize % 2));
    exifChunk[0] = 0x45; // E
    exifChunk[1] = 0x58; // X
    exifChunk[2] = 0x49; // I
    exifChunk[3] = 0x46; // F
    new DataView(exifChunk.buffer).setUint32(4, exifChunkSize, true);
    exifChunk.set(tiffBytes, 8);

    // Add diagnostic logging to background service worker
    chrome.runtime.sendMessage({
      type: 'LOG_ENTRY',
      payload: {
        level: 'INFO',
        message: `[Offscreen WebP] Injecting metadata. Width: ${imgWidth}, Height: ${imgHeight}, app1Block size: ${app1Block.length}`,
        data: { metadata }
      }
    }).catch(() => { });

    const hasVP8X = bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58;

    if (hasVP8X) {
      const flags = bytes[20];
      const newFlags = flags | 0x08; // Set EXIF bit

      const newBytes = new Uint8Array(bytes.length + exifChunk.length);
      newBytes.set(bytes.subarray(0, 30), 0);
      newBytes.set(exifChunk, 30);
      newBytes.set(bytes.subarray(30), 30 + exifChunk.length);

      // Mutate the flags byte on the brand new, writable newBytes array view
      newBytes[20] = newFlags;

      new DataView(newBytes.buffer).setUint32(4, newBytes.length - 8, true);
      return new Blob([newBytes], { type: 'image/webp' });
    } else {
      // Create and insert VP8X chunk
      const vp8xChunk = new Uint8Array(18);
      vp8xChunk[0] = 0x56; // V
      vp8xChunk[1] = 0x50; // P
      vp8xChunk[2] = 0x38; // 8
      vp8xChunk[3] = 0x58; // X
      new DataView(vp8xChunk.buffer).setUint32(4, 10, true);

      let hasAlpha = 0;
      if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c) {
        hasAlpha = 0x10; // set Alpha flag if lossless VP8L
      }

      vp8xChunk[8] = 0x08 | hasAlpha; // EXIF metadata flag

      const w = imgWidth - 1;
      vp8xChunk[12] = w & 0xff;
      vp8xChunk[13] = (w >> 8) & 0xff;
      vp8xChunk[14] = (w >> 16) & 0xff;

      const h = imgHeight - 1;
      vp8xChunk[15] = h & 0xff;
      vp8xChunk[16] = (h >> 8) & 0xff;
      vp8xChunk[17] = (h >> 16) & 0xff;

      const newBytes = new Uint8Array(bytes.length + vp8xChunk.length + exifChunk.length);
      newBytes.set(bytes.subarray(0, 12), 0); // RIFF + size + WEBP
      newBytes.set(vp8xChunk, 12);
      newBytes.set(exifChunk, 30);
      newBytes.set(bytes.subarray(12), 30 + exifChunk.length);

      new DataView(newBytes.buffer).setUint32(4, newBytes.length - 8, true);
      return new Blob([newBytes], { type: 'image/webp' });
    }
  }

  return blob;
}

async function processImageViaApi(
  inputBlob: Blob,
  options: ProcessingOptions
): Promise<Blob> {
  const apiUrl = (options.customBgRemovalUrl || 'http://localhost:8000').trim();
  let baseUrl = apiUrl.replace(/\/remove-bg\/?$/, '').replace(/\/$/, '');
  const processUrl = `${baseUrl}/process-image`;

  const formData = new FormData();
  formData.append('file', inputBlob, 'image.png');
  formData.append('bg_remove', String(options.bgRemoveFlag || false));
  formData.append('crop', String(options.cropFlag || false));
  if (options.bgColorEnableFlag && options.bgColorValueFlag) {
    formData.append('bg_color', options.bgColorValueFlag);
  }
  formData.append('resolution', options.resolution || '0');
  formData.append('contain_fit', String(options.containFit || false));
  formData.append('format', options.format || 'webp');
  formData.append('quality', String(options.quality || 90));
  if (options.targetSizeKb) {
    formData.append('target_size_kb', String(options.targetSizeKb));
  }

  if (options.metadata) {
    const meta = options.metadata;
    if (meta.title) formData.append('title', meta.title);
    if (meta.author) formData.append('author', meta.author);
    if (meta.description) formData.append('description', meta.description);
    if (meta.make) formData.append('make', meta.make);
    if (meta.model) formData.append('model', meta.model);
    if (meta.lensModel) formData.append('lens_model', meta.lensModel);
    if (meta.software) formData.append('software', meta.software);
    if (meta.dateTimeOriginal) formData.append('date_time_original', sanitizeDateTimeString(meta.dateTimeOriginal));
    if (meta.gpsLatitude) formData.append('gps_latitude', meta.gpsLatitude);
    if (meta.gpsLongitude) formData.append('gps_longitude', meta.gpsLongitude);
  }

  logger.info(`[offscreen] processImageViaApi: Requesting ${processUrl} ...`);
  const response = await fetch(processUrl, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Python API Error (${response.status}): ${errText}`);
  }

  const outBlob = await response.blob();
  logger.info(`[offscreen] processImageViaApi success. Blob size: ${outBlob.size}`);
  return outBlob;
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

function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
  };
  return map[mimeType] || 'png';
}

function encodeTiff(
  width: number,
  height: number,
  rgbaBytes: Uint8Array,
  metadata?: any
): Uint8Array {
  const entries: { tag: number; type: number; count: number; value: any }[] = [
    { tag: 256, type: 4, count: 1, value: width }, // ImageWidth
    { tag: 257, type: 4, count: 1, value: height }, // ImageLength
    { tag: 258, type: 3, count: 4, value: null }, // BitsPerSample
    { tag: 259, type: 3, count: 1, value: 1 }, // Compression (1 = none)
    { tag: 262, type: 3, count: 1, value: 2 }, // PhotometricInterpretation (2 = RGB)
    { tag: 273, type: 4, count: 1, value: null }, // StripOffsets
    { tag: 277, type: 3, count: 1, value: 4 }, // SamplesPerPixel (4 = RGBA)
    { tag: 278, type: 4, count: 1, value: height }, // RowsPerStrip
    { tag: 279, type: 4, count: 1, value: width * height * 4 }, // StripByteCounts
    { tag: 282, type: 5, count: 1, value: null }, // XResolution
    { tag: 283, type: 5, count: 1, value: null }, // YResolution
    { tag: 296, type: 3, count: 1, value: 2 } // ResolutionUnit (2 = inch)
  ];

  const stringFields = [
    { name: 'author', tag: 315 },
    { name: 'make', tag: 271 },
    { name: 'model', tag: 272 },
    { name: 'software', tag: 305 },
    { name: 'dateTimeOriginal', tag: 306 }
  ];

  if (metadata) {
    for (const f of stringFields) {
      const val = metadata[f.name];
      if (val && typeof val === 'string') {
        const textBytes = new TextEncoder().encode(val + '\0');
        entries.push({ tag: f.tag, type: 2, count: textBytes.length, value: textBytes });
      }
    }
  }

  entries.sort((a, b) => a.tag - b.tag);

  const headerSize = 8;
  const ifdEntryCount = entries.length;
  const ifdSize = 2 + (ifdEntryCount * 12) + 4;

  let currentOffset = headerSize + ifdSize;

  for (const entry of entries) {
    if (entry.tag === 258) {
      entry.value = currentOffset;
      currentOffset += 8;
    } else if (entry.tag === 282 || entry.tag === 283) {
      entry.value = currentOffset;
      currentOffset += 8;
    } else if (entry.type === 2 && entry.count > 4) {
      const bytes = entry.value as Uint8Array;
      entry.value = currentOffset;
      currentOffset += bytes.length;
    }
  }

  const stripOffsetsEntry = entries.find(e => e.tag === 273);
  const pixelOffset = currentOffset;
  const pixelSize = width * height * 4;
  if (stripOffsetsEntry) {
    stripOffsetsEntry.value = pixelOffset;
  }

  const totalSize = pixelOffset + pixelSize;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);

  view.setUint16(8, ifdEntryCount, true);

  let entryOffset = 10;
  for (const entry of entries) {
    view.setUint16(entryOffset, entry.tag, true);
    view.setUint16(entryOffset + 2, entry.type, true);
    view.setUint32(entryOffset + 4, entry.count, true);

    if (entry.tag === 258 || entry.tag === 282 || entry.tag === 283 || (entry.type === 2 && entry.count > 4)) {
      view.setUint32(entryOffset + 8, entry.value, true);
    } else if (entry.type === 2 && entry.count <= 4) {
      const strBytes = entry.value as Uint8Array;
      for (let j = 0; j < strBytes.length; j++) {
        view.setUint8(entryOffset + 8 + j, strBytes[j]);
      }
    } else {
      view.setUint32(entryOffset + 8, entry.value, true);
    }
    entryOffset += 12;
  }

  view.setUint32(entryOffset, 0, true);

  for (const entry of entries) {
    if (entry.tag === 258) {
      const offsetVal = entry.value;
      view.setUint16(offsetVal, 8, true);
      view.setUint16(offsetVal + 2, 8, true);
      view.setUint16(offsetVal + 4, 8, true);
      view.setUint16(offsetVal + 6, 8, true);
    } else if (entry.tag === 282 || entry.tag === 283) {
      const offsetVal = entry.value;
      view.setUint32(offsetVal, 72, true);
      view.setUint32(offsetVal + 4, 1, true);
    } else if (entry.type === 2 && entry.count > 4) {
      bytes.set(entry.value as Uint8Array, entry.value);
    }
  }

  bytes.set(rgbaBytes, pixelOffset);
  return bytes;
}

function getRandomDateTime(): string {
  const d = new Date();
  d.setHours(d.getHours() - Math.floor(Math.random() * 24));
  d.setMinutes(Math.floor(Math.random() * 60));
  d.setSeconds(Math.floor(Math.random() * 60));
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${Y}:${M}:${D} ${h}:${m}:${s}`;
}

function sanitizeDateTimeString(val: any): string {
  if (!val) return getRandomDateTime();
  if (typeof val === 'string') {
    if (val.includes('[object') || val.trim() === '') {
      return getRandomDateTime();
    }
    return val.trim();
  }
  if (val instanceof Date) {
    const Y = val.getFullYear();
    const M = String(val.getMonth() + 1).padStart(2, '0');
    const D = String(val.getDate()).padStart(2, '0');
    const h = String(val.getHours()).padStart(2, '0');
    const m = String(val.getMinutes()).padStart(2, '0');
    const s = String(val.getSeconds()).padStart(2, '0');
    return `${Y}:${M}:${D} ${h}:${m}:${s}`;
  }
  if (typeof val === 'object') {
    if (val.value && typeof val.value === 'string') {
      return sanitizeDateTimeString(val.value);
    }
  }
  return getRandomDateTime();
}

console.log('[Image Queue] Offscreen document loaded');
