import {
  MSG,
  sendToBackground,
  type ExtensionMessage,
} from '../shared/messages';
import type {
  QueueData,
  QueueItem,
  ProcessingOptions,
  ImageFormat,
} from '../shared/types';
import { DEFAULT_PROMPT_COUNT, MAX_PROMPTS, MIN_PROMPTS } from '../shared/constants';
import { computeQueueStats, STATUS_DISPLAY } from '../queue/queue-types';
import { imageStore } from '../storage/image-store';
import { settingsStorage } from '../storage/storage';
import { uploadToWordPressMedia, blobToBase64 } from '../api/wp-uploader';
import { processImage, removeBackground, cropTransparent } from '../processing/image-processor';

// ─── DOM References ────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const viewInput = $<HTMLElement>('view-input');
const viewQueue = $<HTMLElement>('view-queue');
const viewBatch = $<HTMLElement>('view-batch');
const connectionBanner = $<HTMLElement>('connection-banner');
const connectionText = $<HTMLElement>('connection-text');

const articleNameInput = $<HTMLInputElement>('article-name');
const promptsContainer = $<HTMLElement>('prompts-container');
const btnAddPrompt = $<HTMLButtonElement>('btn-add-prompt');
const btnGenerate = $<HTMLButtonElement>('btn-generate');
const btnSettings = $<HTMLButtonElement>('btn-settings');
const btnOpenChatGPT = $<HTMLButtonElement>('btn-open-chatgpt');
const providerSelect = $<HTMLSelectElement>('provider-select');

const queueArticleName = $<HTMLElement>('queue-article-name');
const queueProgressText = $<HTMLElement>('queue-progress-text');
const progressBar = $<HTMLElement>('progress-bar');
const queueItemsContainer = $<HTMLElement>('queue-items');
const btnPause = $<HTMLButtonElement>('btn-pause');
const btnResume = $<HTMLButtonElement>('btn-resume');
const btnCancel = $<HTMLButtonElement>('btn-cancel');
const btnBackInput = $<HTMLButtonElement>('btn-back-input');

const batchImageList = $<HTMLElement>('batch-image-list');
const formatGroup = $<HTMLElement>('format-group');
const qualityInput = $<HTMLInputElement>('quality');
const qualityValue = $<HTMLElement>('quality-value');
const resolutionSelect = $<HTMLSelectElement>('resolution');
const filenamePrefixInput = $<HTMLInputElement>('filename-prefix');
const authorNameInput = $<HTMLInputElement>('author-name');
const filenamePreview = $<HTMLElement>('filename-preview');
const btnDownloadZip = $<HTMLButtonElement>('btn-download-zip');
const btnUploadWP = $<HTMLButtonElement>('btn-upload-wp');
const btnDownloadIndividual = $<HTMLButtonElement>('btn-download-individual');
const btnNewBatch = $<HTMLButtonElement>('btn-new-batch');

const exifDeviceSelect = $<HTMLSelectElement>('exif-device-select');
const debugLogsEntries = $<HTMLElement>('debug-logs-entries');
const btnClearPopupLogs = $<HTMLButtonElement>('btn-clear-popup-logs');
const exifToggle = $<HTMLInputElement>('exif-toggle');
const btnClearExif = $<HTMLButtonElement>('btn-clear-exif');
const btnRandomExif = $<HTMLButtonElement>('btn-random-exif');
const exifFieldsContainer = $<HTMLElement>('exif-fields-container');

const btnAdvancedExifToggle = $<HTMLButtonElement>('btn-advanced-exif-toggle');
const advancedExifIcon = $<HTMLElement>('advanced-exif-icon');
const advancedExifFields = $<HTMLElement>('advanced-exif-fields');

const exifMakeInput = $<HTMLInputElement>('exif-make');
const exifModelInput = $<HTMLInputElement>('exif-model');
const exifLensInput = $<HTMLInputElement>('exif-lens');
const exifSoftwareInput = $<HTMLInputElement>('exif-software');
const exifCopyrightInput = $<HTMLInputElement>('exif-copyright');
const exifDateInput = $<HTMLInputElement>('exif-date');
const exifCountryInput = $<HTMLInputElement>('exif-country');
const exifStateInput = $<HTMLInputElement>('exif-state');
const exifCityInput = $<HTMLInputElement>('exif-city');
const exifSublocInput = $<HTMLInputElement>('exif-subloc');
const exifLatInput = $<HTMLInputElement>('exif-lat');
const exifLonInput = $<HTMLInputElement>('exif-lon');

const productNameField = $<HTMLElement>('product-name-field');
const productNameInput = $<HTMLInputElement>('product-name-input');

const DEFAULT_PROMPTS_TEMPLATES = [
  `Create a hyper-realistic, candid-style photo of a single human hand holding a product labeled "[product]".\n🔹 Composition: Only the hand is visible (from mid-forearm down), natural skin texture with subtle imperfections, no jewelry or nail polish. Product is clearly visible and centered in the hand, with "[product]" legible on packaging. Tight crop on hand + product: no face, no full body.\n🔹 Background (CRITICAL): Set in a realistic, lived-in indoor room (e.g., cozy living room, bedroom corner, or home office). Background must be VISIBLE and IN-FOCUS (no heavy blur/bokeh) — show authentic environmental details: slightly rumpled couch or bed sheets, a coffee mug, books, or charging cables, plant.\n🔹 Aesthetic & Technical Style: Shot on a modern smartphone (iPhone/Android style): slight lens distortion, natural dynamic range, mild noise/grain. Warm ambient lighting.\n🔹 Output Specs: Resolution: 1200x628 pixels. Format: JPG-style compression.`,
  `Create a hyper-realistic photo of "[product]" being used. Show the open bottle with the lid open, next to a hand holding capsules, captured casually on a smartphone. Warm ambient lighting, cozy home environment in the background. Resolution: 1200x628 pixels. Format: JPG-style compression.`,
  `Generate a realistic image of "[product]" unboxed on a surface. Include realistic evidence of the original shipping package (e.g., torn shipping box, packing paper, utility-knife cut along the top seam, open box flaps) resting in the background or side. Product packaging remains the main focus. Packing material naturally disturbed, spilling from open flap. Product is slightly off-center, casual positioning. Casual smartphone photo, natural ambient lighting.\n🔹 Output Specs: Resolution: 1200x628 pixels. Format: JPG-style compression.`,
  `Create a realistic BEFORE AND AFTER comparison image for "[product]" using a side-by-side comparison (BEFORE on the left, AFTER on the right). Both panels must depict the same subject (person, body part, or environment) with similar framing and composition. Preserve identity, skin tone, hair color, and general environment. Only the intended improvement changes. Subtle differences in lighting, posture, wrinkles, and background details are allowed to show separate moments in time (temporal evolution). Smartphone photo realism.`,
  `Create a professional widescreen feature image of a single "[product]" package centered against a clean, solid background in a color that matches and complements the product's branding and packaging color. Sharp details, centered studio composition. Resolution: 1200x628 pixels. Widescreen 16:9 aspect ratio. Format: JPG-style compression.`,
  `Create a professional product image of a single "[product]" bottle against a clean, solid background in a color that matches and complements the product's packaging and branding color. Sharp details, centered studio composition. Resolution: 300x300 pixels. Square 1:1 aspect ratio. Format: JPG-style compression.`
];

const referenceImageInput = $<HTMLInputElement>('reference-image-input');
const btnUploadRef = $<HTMLButtonElement>('btn-upload-ref');
const refImageStatus = $<HTMLElement>('ref-image-status');
const btnClearRef = $<HTMLButtonElement>('btn-clear-ref');

const targetSizeInput = $<HTMLInputElement>('target-size');

// ─── State ─────────────────────────────────────────────────────

let currentQueue: QueueData | null = null;
let promptCount = 0;
let lastProductName = '[product]';

// ─── View Management ───────────────────────────────────────────

function showView(view: 'input' | 'queue' | 'batch'): void {
  viewInput.style.display = view === 'input' ? 'flex' : 'none';
  viewQueue.style.display = view === 'queue' ? 'flex' : 'none';
  viewBatch.style.display = view === 'batch' ? 'flex' : 'none';
}

// ─── Fullscreen Image Lightbox ─────────────────────────────────

const lightboxOverlay = document.createElement('div');
lightboxOverlay.id = 'image-lightbox';
lightboxOverlay.style.cssText = `
  display:none; position:fixed; inset:0; z-index:9999;
  background:rgba(0,0,0,0.92); backdrop-filter:blur(8px);
  align-items:center; justify-content:center; cursor:zoom-out;
  animation: lightboxFadeIn 0.2s ease;
`;
lightboxOverlay.innerHTML = `
  <button id="lightbox-close" style="position:absolute; top:12px; right:16px; background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:24px; width:36px; height:36px; border-radius:50%; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background 0.2s; z-index:10000;" title="Close">✕</button>
  <img id="lightbox-img" src="" alt="Preview" style="max-width:95%; max-height:90vh; object-fit:contain; border-radius:8px; box-shadow:0 8px 40px rgba(0,0,0,0.5); cursor:default;" />
`;
document.body.appendChild(lightboxOverlay);

// Inject keyframe animation
const lightboxStyle = document.createElement('style');
lightboxStyle.textContent = `
  @keyframes lightboxFadeIn { from { opacity:0; } to { opacity:1; } }
  #lightbox-close:hover { background:rgba(255,255,255,0.2); }
  #lightbox-img { animation: lightboxZoomIn 0.2s ease; }
  @keyframes lightboxZoomIn { from { transform:scale(0.9); opacity:0; } to { transform:scale(1); opacity:1; } }
`;
document.head.appendChild(lightboxStyle);

function openLightbox(imgSrc: string) {
  const img = lightboxOverlay.querySelector('#lightbox-img') as HTMLImageElement;
  img.src = imgSrc;
  lightboxOverlay.style.display = 'flex';
}

function closeLightbox() {
  lightboxOverlay.style.display = 'none';
  const img = lightboxOverlay.querySelector('#lightbox-img') as HTMLImageElement;
  img.src = '';
}

lightboxOverlay.addEventListener('click', (e) => {
  if (e.target === lightboxOverlay) closeLightbox();
});
lightboxOverlay.querySelector('#lightbox-close')!.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lightboxOverlay.style.display === 'flex') closeLightbox();
});

// ─── Prompt Management ─────────────────────────────────────────

function addPromptField(value = ''): void {
  if (promptCount >= MAX_PROMPTS) return;

  promptCount++;
  const num = promptCount;
  const promptUid = crypto.randomUUID();

  const group = document.createElement('div');
  group.className = 'prompt-group';
  group.dataset.promptIndex = String(num);
  group.dataset.promptUid = promptUid;

  group.innerHTML = `
    <div class="prompt-label" style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
      <div style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" class="prompt-toggle-check" checked style="width:12px; height:12px; accent-color:var(--accent); cursor:pointer;" />
        <span class="prompt-label-text">Prompt ${num}</span>
      </div>
      ${num > MIN_PROMPTS ? '<button class="prompt-remove" title="Remove prompt">×</button>' : ''}
    </div>
    <textarea
      class="prompt-textarea"
      placeholder="Describe the image you want to generate..."
      rows="2"
      style="transition: opacity 0.2s;"
    >${escapeHtml(value)}</textarea>
    <div class="prompt-ref-image-section" style="margin-top:6px; display:flex; align-items:center; gap:8px; width:100%; transition: opacity 0.2s;">
      <button class="btn-prompt-ref-image" style="font-size:10px; padding:4px 8px; border:1px dashed rgba(255,255,255,0.15); border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer; transition:all 0.2s;">
        📎 Choose Reference Image
      </button>
      <input type="file" class="prompt-ref-image-input" accept="image/*" style="display:none;" />
      <span class="prompt-ref-image-status" style="font-size:10px; color:var(--text-muted); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:140px;">No image selected</span>
      <button class="btn-prompt-ref-clear" style="display:none; border:none; background:transparent; color:#ef4444; font-size:10px; cursor:pointer; padding:2px 4px;">Remove</button>
    </div>
  `;

  const checkToggle = group.querySelector('.prompt-toggle-check') as HTMLInputElement;
  const textarea = group.querySelector('.prompt-textarea') as HTMLTextAreaElement;
  const refSection = group.querySelector('.prompt-ref-image-section') as HTMLElement;

  checkToggle.addEventListener('change', () => {
    if (checkToggle.checked) {
      textarea.disabled = false;
      textarea.style.opacity = '1';
      refSection.style.opacity = '1';
      refSection.style.pointerEvents = 'auto';
    } else {
      textarea.disabled = true;
      textarea.style.opacity = '0.4';
      refSection.style.opacity = '0.4';
      refSection.style.pointerEvents = 'none';
    }
  });

  const removeBtn = group.querySelector('.prompt-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      const uidKey = `ref-image-prompt-${group.dataset.promptUid}`;
      try {
        await imageStore.delete(uidKey);
      } catch (err) {
        console.error('Failed to delete temp reference image:', err);
      }
      group.remove();
      renumberPrompts();
    });
  }

  const btnSelect = group.querySelector('.btn-prompt-ref-image') as HTMLButtonElement;
  const fileInput = group.querySelector('.prompt-ref-image-input') as HTMLInputElement;
  const statusSpan = group.querySelector('.prompt-ref-image-status') as HTMLSpanElement;
  const btnClear = group.querySelector('.btn-prompt-ref-clear') as HTMLButtonElement;

  btnSelect.addEventListener('click', (e) => {
    e.preventDefault();
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file) {
      statusSpan.textContent = file.name;
      statusSpan.style.color = '#3b82f6';
      btnClear.style.display = 'inline-block';
      btnSelect.innerHTML = '📎 Change Reference Image';
      
      const uidKey = `ref-image-prompt-${group.dataset.promptUid}`;
      await imageStore.store(uidKey, file, undefined, undefined, file.name);
    }
  });

  btnClear.addEventListener('click', async (e) => {
    e.preventDefault();
    fileInput.value = '';
    statusSpan.textContent = 'No image selected';
    statusSpan.style.color = 'var(--text-muted)';
    btnClear.style.display = 'none';
    btnSelect.innerHTML = '📎 Choose Reference Image';
    
    const uidKey = `ref-image-prompt-${group.dataset.promptUid}`;
    await imageStore.delete(uidKey);
  });

  promptsContainer.appendChild(group);
  updateAddButton();
}

function renumberPrompts(): void {
  const groups = promptsContainer.querySelectorAll('.prompt-group');
  promptCount = groups.length;
  groups.forEach((group, i) => {
    const label = group.querySelector('.prompt-label-text');
    if (label) label.textContent = `Prompt ${i + 1}`;
    (group as HTMLElement).dataset.promptIndex = String(i + 1);
  });
  updateAddButton();
}

function updateAddButton(): void {
  btnAddPrompt.style.display = promptCount >= MAX_PROMPTS ? 'none' : 'inline-flex';
}

async function getPromptsData(): Promise<{ prompts: string[]; hasRefImage: boolean[] }> {
  const promptGroups = promptsContainer.querySelectorAll('.prompt-group');
  const prompts: string[] = [];
  const hasRefImage: boolean[] = [];

  for (let i = 0; i < promptGroups.length; i++) {
    const group = promptGroups[i] as HTMLElement;
    const checkToggle = group.querySelector('.prompt-toggle-check') as HTMLInputElement | null;
    if (checkToggle && !checkToggle.checked) {
      continue; // Skip disabled/unchecked prompts!
    }

    const ta = group.querySelector('.prompt-textarea') as HTMLTextAreaElement;
    const promptText = ta.value.trim();
    if (promptText) {
      prompts.push(promptText);

      const fileInput = group.querySelector('.prompt-ref-image-input') as HTMLInputElement;
      const fileUploaded = !!(fileInput.files && fileInput.files.length > 0);
      hasRefImage.push(fileUploaded);

      if (fileUploaded) {
        const uidKey = `ref-image-prompt-${group.dataset.promptUid}`;
        const seqKey = `ref-image-prompt-${prompts.length}`;
        try {
          const tempImg = await imageStore.get(uidKey);
          if (tempImg) {
            await imageStore.store(seqKey, tempImg.blob, undefined, undefined, tempImg.localFilename);
          }
        } catch (err) {
          console.error('Failed to copy prompt reference image sequentially:', err);
        }
      }
    }
  }

  return { prompts, hasRefImage };
}

// ─── Queue Rendering ───────────────────────────────────────────

function renderQueue(queue: QueueData): void {
  currentQueue = queue;
  const stats = computeQueueStats(queue.items);

  // Header
  queueArticleName.textContent = queue.articleName;
  queueProgressText.textContent = `${stats.completed}/${stats.total} completed`;
  progressBar.style.width = `${stats.progressPercent}%`;

  // Stop shimmer when complete
  if (queue.state === 'completed' || queue.state === 'idle') {
    progressBar.style.setProperty('--shimmer-opacity', '0');
  }

  // Items
  queueItemsContainer.innerHTML = '';
  queue.items.forEach((item, i) => {
    queueItemsContainer.appendChild(createQueueItemElement(item, i + 1));
  });

  // Controls
  const isActive = queue.state === 'running';
  const isPaused = queue.state === 'paused' || queue.state === 'error';
  const isFinished = queue.state === 'completed';

  btnPause.style.display = isActive ? 'inline-flex' : 'none';
  btnResume.style.display = isPaused ? 'inline-flex' : 'none';
  btnCancel.style.display = isFinished ? 'none' : 'inline-flex';
  btnBackInput.style.display = (isFinished && stats.completed === 0) ? 'inline-flex' : 'none';

  // Auto-switch to batch view when complete
  if (isFinished && stats.completed > 0) {
    showBatchView(queue);
  }
}

function createQueueItemElement(item: QueueItem, index: number): HTMLElement {
  const el = document.createElement('div');
  el.className = `queue-item is-${item.status}`;

  const display = STATUS_DISPLAY[item.status];
  const statusIcon = item.status === 'generating'
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83"/></svg>`
    : display.icon;

  el.innerHTML = `
    <div class="qi-status-icon ${item.status}">${statusIcon}</div>
    <div class="qi-content">
      <div class="qi-prompt" title="${escapeHtml(item.prompt)}">
        ${escapeHtml(item.prompt.length > 60 ? item.prompt.slice(0, 60) + '…' : item.prompt)}
      </div>
      <div class="qi-meta">
        <span>Image ${index}</span>
        <span>·</span>
        <span style="color:${display.color}">${display.label}</span>
        ${item.error ? `<span>· ${escapeHtml(item.error.slice(0, 40))}</span>` : ''}
        ${item.retryCount > 0 ? `<span>· Retry ${item.retryCount}</span>` : ''}
      </div>
    </div>
    <div class="qi-actions">
      ${item.status === 'failed' ? `
        <button class="qi-action-btn retry" title="Retry" data-action="retry" data-id="${item.id}">↻</button>
        <button class="qi-action-btn" title="Skip" data-action="skip" data-id="${item.id}">→</button>
      ` : ''}
      ${item.status !== 'generating' ? `
        <button class="qi-action-btn remove" title="Remove" data-action="remove" data-id="${item.id}">×</button>
      ` : ''}
    </div>
  `;

  // Action handlers
  el.querySelectorAll('.qi-action-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const action = target.dataset.action;
      const id = target.dataset.id;
      if (!action || !id) return;

      switch (action) {
        case 'retry':
          sendToBackground(MSG.RETRY_ITEM, { itemId: id });
          break;
        case 'skip':
          sendToBackground(MSG.SKIP_ITEM, { itemId: id });
          break;
        case 'remove':
          sendToBackground(MSG.REMOVE_ITEM, { itemId: id });
          break;
      }
    });
  });

  return el;
}

// ─── Batch View ─────────────────────────────────────────────── 

function showBatchView(queue: QueueData): void {
  showView('batch');

  const completedItems = queue.items.filter((i) => i.status === 'completed');

  // Default prefix from article name
  const prefix = queue.articleName || 'image';
  filenamePrefixInput.value = prefix;

  // Image list
  batchImageList.innerHTML = '';
  completedItems.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'batch-image-item';
    el.dataset.id = item.id;

    const suffix = getIntelligentSuffix(item.prompt, i);
    const defaultName = `${prefix}-${suffix}`;
    const isProductImg = item.prompt.toLowerCase().includes('background removed') || item.prompt.toLowerCase().includes('product image');
    const isFeatureImg = item.prompt.toLowerCase().includes('feature image');

    let defaultRes = 'default';
    if (isProductImg) {
      defaultRes = '340x340';
    } else if (isFeatureImg) {
      defaultRes = '872x560';
    }
    
    el.innerHTML = `
      <div class="batch-image-row">
        <div class="batch-image-index-badge">
          <span class="batch-image-index-num">${i + 1}</span>
          <div class="batch-image-thumbnail-container" data-id="${item.id}" style="width:100%; height:100%; display:flex; align-items:center; justify-content:center;">
            <svg class="batch-image-type-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </div>
        </div>
        <div class="batch-image-details" title="${escapeHtml(item.prompt)}">
          <div class="batch-image-rename-row" style="display:flex; align-items:center; gap:6px; margin-bottom:6px; width:100%;">
            <input type="text" class="input batch-image-name-input" data-id="${item.id}" value="${defaultName}" placeholder="Filename" style="flex:1; min-width:0; height:24px; font-size:11px;" />
            <span class="batch-image-ext-preview" style="flex-shrink:0;">${isProductImg ? '.png' : '.webp'}</span>
            <span class="batch-image-device-badge" style="font-size:9px; color:var(--text-muted); background:rgba(255,255,255,0.05); padding:1px 6px; border-radius:4px; white-space:nowrap; border:1px solid rgba(255,255,255,0.03); flex-shrink:0;">📷 Picking device...</span>
          </div>
          <div class="batch-image-controls-row" style="display:flex; align-items:center; gap:6px; width:100%;">
            <select class="select batch-resolution-select" data-id="${item.id}" style="flex-shrink:0; width:110px; height:24px; padding:0 18px 0 6px !important; background-position:right 6px center !important; font-size:9px; background-color:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); color:var(--text-normal); border-radius:4px; cursor:pointer; font-weight:500;">
              <option value="default"${defaultRes === 'default' ? ' selected' : ''}>Global Size</option>
              <option value="0"${defaultRes === '0' ? ' selected' : ''}>Original</option>
              <option value="872x560"${defaultRes === '872x560' ? ' selected' : ''}>872x560 (Blog)</option>
              <option value="340x340"${defaultRes === '340x340' ? ' selected' : ''}>340x340 (Product)</option>
              <option value="1200x628">1200x628 (WP Wide)</option>
              <option value="1200x1200">1200x1200 (Square)</option>
            </select>
            <select class="select batch-bg-select" data-id="${item.id}" style="flex-shrink:0; width:95px; height:24px; padding:0 18px 0 6px !important; background-position:right 6px center !important; font-size:9px; background-color:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); color:var(--text-normal); border-radius:4px; cursor:pointer; font-weight:500;">
              <option value="original"${!isProductImg ? ' selected' : ''}>No Cutout</option>
              <option value="transparent"${isProductImg ? ' selected' : ''}>Transparent</option>
              <option value="color">Solid Color</option>
            </select>
            <input type="color" class="batch-bg-color-picker" data-id="${item.id}" value="#ffffff" style="display:none; width:22px; height:22px; border:1px solid rgba(255,255,255,0.15); padding:0; background:transparent; cursor:pointer; border-radius:4px; flex-shrink:0;" />
            <label class="batch-crop-toggle" title="Auto-crop transparent borders" style="display:flex; align-items:center; gap:3px; font-size:9px; color:var(--text-muted); cursor:pointer; flex-shrink:0; padding:2px 6px; border-radius:4px; border:1px solid rgba(255,255,255,0.08); background:${isProductImg ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)'};">
              <input type="checkbox" class="batch-crop-check" data-id="${item.id}" ${isProductImg ? 'checked' : ''} style="width:12px; height:12px; accent-color:#3b82f6; cursor:pointer;" />
              <span>Crop✂️</span>
            </label>
          </div>
        </div>
      </div>
    `;

    // Listen to manual user inputs to mark as dirty
    const input = el.querySelector('.batch-image-name-input') as HTMLInputElement;
    input.addEventListener('input', () => {
      input.classList.add('is-dirty');
      updateFilenamePreview();
    });

    const bgSelect = el.querySelector('.batch-bg-select') as HTMLSelectElement;
    const bgPicker = el.querySelector('.batch-bg-color-picker') as HTMLInputElement;
    const cropCheck = el.querySelector('.batch-crop-check') as HTMLInputElement;

    const handleBgModeChange = () => {
      const mode = bgSelect?.value || 'original';
      if (mode === 'color') {
        bgPicker.style.display = 'block';
      } else {
        bgPicker.style.display = 'none';
      }
      updateThumbnailPreview();
    };

    const updateThumbnailPreview = async () => {
      const storedImage = await imageStore.get(item.id);
      if (!storedImage) return;

      const container = el.querySelector('.batch-image-thumbnail-container') as HTMLElement;
      if (!container) return;

      const bgMode = bgSelect?.value || 'original';
      const isBg = bgMode === 'transparent' || bgMode === 'color';
      const isCrop = cropCheck?.checked || false;
      const isBgCol = bgMode === 'color';
      const bgColorVal = bgPicker?.value || '#ffffff';

      const cropLabel = el.querySelector('.batch-crop-toggle') as HTMLElement;
      if (cropLabel) cropLabel.style.background = isCrop ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)';

      let blob = storedImage.blob;
      if (isBg) {
        try {
          blob = await removeBackground(blob);
        } catch (e) {
          console.error('BG removal failed:', e);
        }
      }
      if (isCrop) {
        try {
          blob = await cropTransparent(blob);
        } catch (e) {
          console.error('Crop transparent failed:', e);
        }
      }
      if (isBgCol) {
        try {
          blob = await fillBackgroundColorClient(blob, bgColorVal);
        } catch (e) {
          console.error('Fill background color failed:', e);
        }
      }

      const url = URL.createObjectURL(blob);
      container.innerHTML = `<img src="${url}" class="batch-image-thumbnail" style="width:100%; height:100%; object-fit:contain; border-radius:4px;" />`;
      if ((isBg || isCrop) && !isBgCol) {
        container.style.background = 'repeating-conic-gradient(#808080 0% 25%, #fff 0% 50%) 50% / 10px 10px';
      } else {
        container.style.background = 'none';
      }

      // Update extension preview
      const extPreview = el.querySelector('.batch-image-ext-preview');
      if (extPreview) {
        if ((isBg || isCrop) && !isBgCol) {
          extPreview.textContent = '.png';
        } else {
          const formatInput = document.querySelector('input[name="format"]:checked') as HTMLInputElement;
          extPreview.textContent = `.${formatInput?.value || 'webp'}`;
        }
      }
    };

    if (bgSelect) bgSelect.addEventListener('change', handleBgModeChange);
    if (bgPicker) bgPicker.addEventListener('change', updateThumbnailPreview);
    if (bgPicker) bgPicker.addEventListener('input', updateThumbnailPreview);
    if (cropCheck) cropCheck.addEventListener('change', updateThumbnailPreview);

    // Initialize color picker visibility
    if (bgSelect?.value === 'color') {
      bgPicker.style.display = 'block';
    }

    // Asynchronously load thumbnail preview from IndexedDB imageStore
    updateThumbnailPreview().then(() => {
      const container = el.querySelector('.batch-image-thumbnail-container') as HTMLElement;
      if (container) {
        container.style.cursor = 'zoom-in';
        container.addEventListener('click', () => {
          const thumbImg = container.querySelector('.batch-image-thumbnail') as HTMLImageElement;
          if (thumbImg) openLightbox(thumbImg.src);
        });
      }
    });

    batchImageList.appendChild(el);
  });

  // Reset target size input
  targetSizeInput.value = '';

  settingsStorage.load().then((settings) => {
    if (settings && settings.authorName) {
      authorNameInput.value = settings.authorName;
    }
  });

  // Auto-populate a random device + location by default
  if (exifToggle.checked) {
    const device = DEVICE_PRESETS[Math.floor(Math.random() * DEVICE_PRESETS.length)];
    const location = LOCATION_PRESETS[Math.floor(Math.random() * LOCATION_PRESETS.length)];
    const author = AUTHOR_PRESETS[Math.floor(Math.random() * AUTHOR_PRESETS.length)];
    exifMakeInput.value = device.make;
    exifModelInput.value = device.model;
    exifLensInput.value = device.lensModel;
    exifSoftwareInput.value = device.software;
    exifCopyrightInput.value = `© 2026 ${author}`;
    exifDateInput.value = getRandomDateTime();
    exifCountryInput.value = location.country;
    exifStateInput.value = location.state;
    exifCityInput.value = location.city;
    exifSublocInput.value = location.subLocation;
    exifLatInput.value = location.lat;
    exifLonInput.value = location.lon;

    // Give each card its own unique random device + location
    const cards = batchImageList.querySelectorAll('.batch-image-item');
    cards.forEach((el) => {
      randomizeCardExif(el as HTMLElement);
    });
  }

  updateAllCardBadges();
  updateFilenamePreview();
  updateExtensionPreviews();
}

// applyTemplate removed in favor of default 4 variations layout

function getProcessingOptions(): ProcessingOptions {
  const formatInput = document.querySelector(
    'input[name="format"]:checked'
  ) as HTMLInputElement;

  // Collect individual custom filenames
  const customFilenames: Record<string, string> = {};
  const inputs = batchImageList.querySelectorAll('.batch-image-name-input');
  inputs.forEach((input) => {
    const htmlInput = input as HTMLInputElement;
    const id = htmlInput.dataset.id;
    const val = htmlInput.value.trim();
    if (id && val) {
      customFilenames[id] = val;
    }
  });

  // Collect individual Background Mode, Color, and Crop states
  const bgRemove: Record<string, boolean> = {};
  const crop: Record<string, boolean> = {};
  const bgColorEnable: Record<string, boolean> = {};
  const bgColorValue: Record<string, string> = {};

  const bgSelects = batchImageList.querySelectorAll('.batch-bg-select');
  bgSelects.forEach((select) => {
    const htmlSelect = select as HTMLSelectElement;
    const id = htmlSelect.dataset.id;
    if (id) {
      const mode = htmlSelect.value;
      bgRemove[id] = (mode === 'transparent' || mode === 'color');
      bgColorEnable[id] = (mode === 'color');
    }
  });

  const cropChecks = batchImageList.querySelectorAll('.batch-crop-check');
  cropChecks.forEach((chk) => {
    const htmlChk = chk as HTMLInputElement;
    const id = htmlChk.dataset.id;
    if (id) {
      crop[id] = htmlChk.checked;
    }
  });

  const bgPickers = batchImageList.querySelectorAll('.batch-bg-color-picker');
  bgPickers.forEach((picker) => {
    const htmlPicker = picker as HTMLInputElement;
    const id = htmlPicker.dataset.id;
    if (id) {
      bgColorValue[id] = htmlPicker.value;
    }
  });

  const customResolutions: Record<string, string> = {};
  const resSelects = batchImageList.querySelectorAll('.batch-resolution-select');
  resSelects.forEach((select) => {
    const htmlSelect = select as HTMLSelectElement;
    const id = htmlSelect.dataset.id;
    const val = htmlSelect.value;
    if (id && val && val !== 'default') {
      customResolutions[id] = val;
    }
  });

  console.log('[popup] getProcessingOptions collected:', { bgRemove, crop, customResolutions, bgColorEnable, bgColorValue });

  // Collect individual custom metadata
  const customMetadata: Record<string, any> = {};
  if (exifToggle.checked) {
    const cards = batchImageList.querySelectorAll('.batch-image-item');
    cards.forEach((el) => {
      const card = el as HTMLElement;
      const id = card.dataset.id;
      if (id) {
        customMetadata[id] = {
          make: card.dataset.make || undefined,
          model: card.dataset.model || undefined,
          lensModel: card.dataset.lensModel || undefined,
          software: card.dataset.software || undefined,
          copyright: card.dataset.copyright || undefined,
          country: card.dataset.country || undefined,
          state: card.dataset.state || undefined,
          city: card.dataset.city || undefined,
          subLocation: card.dataset.subLocation || undefined,
          gpsLatitude: card.dataset.gpsLatitude || undefined,
          gpsLongitude: card.dataset.gpsLongitude || undefined,
          dateTimeOriginal: card.dataset.dateTimeOriginal || undefined,
        };
      }
    });
  }

  return {
    format: (formatInput?.value as ImageFormat) || 'webp',
    quality: parseInt(qualityInput.value) || 90,
    targetSizeKb: parseInt(targetSizeInput.value) || undefined,
    resolution: resolutionSelect.value || '0',
    filenamePrefix: filenamePrefixInput.value.trim() || 'image',
    customFilenames,
    bgRemove,
    crop,
    customResolutions,
    bgColorEnable,
    bgColorValue,
    customMetadata,
    metadata: exifToggle.checked ? {
      make: exifMakeInput.value.trim(),
      model: exifModelInput.value.trim(),
      lensModel: exifLensInput.value.trim(),
      software: exifSoftwareInput.value.trim(),
      copyright: exifCopyrightInput.value.trim(),
      country: exifCountryInput.value.trim(),
      state: exifStateInput.value.trim(),
      city: exifCityInput.value.trim(),
      subLocation: exifSublocInput.value.trim(),
      gpsLatitude: exifLatInput.value.trim(),
      gpsLongitude: exifLonInput.value.trim(),
      dateTimeOriginal: exifDateInput.value.trim(),
    } : undefined,
    adjustments: {
      brightness: 100,
      contrast: 100,
      saturation: 100,
      grayscale: 0,
      rotate: 0,
      flipH: false,
      flipV: false,
    }
  };
}

function updateExtensionPreviews(): void {
  const formatInput = document.querySelector(
    'input[name="format"]:checked'
  ) as HTMLInputElement;
  const val = formatInput?.value || 'webp';
  const ext = val === 'def' ? ' (Default)' : `.${val}`;
  
  const previews = batchImageList.querySelectorAll('.batch-image-ext-preview');
  previews.forEach((p) => {
    p.textContent = ext;
  });
}

function updateIndividualNames(): void {
  const prefix = filenamePrefixInput.value.trim() || 'image';
  const inputs = batchImageList.querySelectorAll('.batch-image-name-input');
  inputs.forEach((input, i) => {
    const htmlInput = input as HTMLInputElement;
    if (!htmlInput.classList.contains('is-dirty')) {
      htmlInput.value = `${prefix}-${String(i + 1).padStart(2, '0')}`;
    }
  });
}

function updateFilenamePreview(): void {
  const options = getProcessingOptions();
  const ext = options.format;
  const count = currentQueue
    ? currentQueue.items.filter((i) => i.status === 'completed').length
    : 4;

  let html = '<strong>Example output:</strong><br>';
  const max = Math.min(count, 4);
  
  // Use custom filenames in preview if available
  const completedItems = currentQueue
    ? currentQueue.items.filter((i) => i.status === 'completed')
    : [];

  for (let i = 0; i < max; i++) {
    let name = '';
    if (completedItems[i] && options.customFilenames && options.customFilenames[completedItems[i].id]) {
      name = options.customFilenames[completedItems[i].id];
    } else {
      name = `${options.filenamePrefix}-${String(i + 1).padStart(2, '0')}`;
    }
    html += `<span class="filename">${escapeHtml(name)}.${ext}</span><br>`;
  }
  if (count > max) {
    html += `<span class="filename">… and ${count - max} more</span>`;
  }
  filenamePreview.innerHTML = html;
}

// ─── Event Handlers ────────────────────────────────────────────

async function handleGenerate(): Promise<void> {
  const { prompts, hasRefImage } = await getPromptsData();
  if (prompts.length === 0) {
    showBanner('warning', 'Please enter at least one prompt');
    return;
  }

  const articleName = articleNameInput.value.trim() || 'image';

  // Disable button and show loading
  btnGenerate.disabled = true;
  btnGenerate.innerHTML = '<div class="spinner"></div> Starting…';

  try {
    const result = await sendToBackground<{ success: boolean; error?: string }>(
      MSG.START_QUEUE,
      { articleName, prompts, hasRefImage }
    );

    if (result?.success) {
      showView('queue');
      // Request initial status
      const status = await sendToBackground<QueueData>(MSG.GET_QUEUE_STATUS);
      if (status) renderQueue(status);
    } else {
      showBanner('error', result?.error || 'Failed to start queue');
    }
  } catch (err) {
    showBanner('error', `Error: ${err}`);
  } finally {
    btnGenerate.disabled = false;
    btnGenerate.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      Generate All
    `;
  }
}

async function handleDownloadZip(): Promise<void> {
  btnDownloadZip.disabled = true;
  btnDownloadZip.innerHTML = '<div class="spinner"></div> Creating ZIP…';

  try {
    const options = getProcessingOptions();
    const result = await sendToBackground<{ success: boolean; error?: string }>(
      MSG.DOWNLOAD_ZIP,
      { options, articleName: currentQueue?.articleName || 'image' }
    );

    if (!result?.success) {
      showBanner('error', result?.error || 'Failed to create ZIP');
    }
  } catch (err) {
    showBanner('error', `ZIP error: ${err}`);
  } finally {
    btnDownloadZip.disabled = false;
    btnDownloadZip.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Download ZIP
    `;
  }
}

async function handleUploadWP(): Promise<void> {
  const settings = await settingsStorage.load();
  if (!settings.wpEnabled || !settings.wpSiteUrl || !settings.wpApiKey) {
    showBanner('error', 'WordPress upload is not enabled or not fully configured in settings.');
    return;
  }

  const completedItems = currentQueue?.items.filter(i => i.status === 'completed') || [];
  if (completedItems.length === 0) {
    showBanner('warning', 'No completed images to upload.');
    return;
  }

  btnUploadWP.disabled = true;
  const originalHTML = btnUploadWP.innerHTML;
  btnUploadWP.innerHTML = '<div class="spinner"></div> Uploading...';

  try {
    const options = getProcessingOptions();
    const prefix = options.filenamePrefix || 'image';

    for (let i = 0; i < completedItems.length; i++) {
      const item = completedItems[i];
      btnUploadWP.innerHTML = `<div class="spinner"></div> Uploading ${i + 1}/${completedItems.length}...`;

      // Get image blob from IndexedDB imageStore
      const storedImage = await imageStore.get(item.id);
      if (!storedImage) {
        throw new Error(`Failed to find image data for prompt ${i + 1}`);
      }

      // Process/compress the image
      let processedBlob = await processImage(storedImage.blob, options);

      // Check if BG Remove and Crop toggles are checked for this card
      const bgCheck = batchImageList.querySelector(`.batch-bg-remove-check[data-id="${item.id}"]`) as HTMLInputElement | null;
      const cropCheck = batchImageList.querySelector(`.batch-crop-check[data-id="${item.id}"]`) as HTMLInputElement | null;
      const isBgRemove = bgCheck?.checked || false;
      const isCrop = cropCheck?.checked || false;

      if (isBgRemove) {
        processedBlob = await removeBackground(processedBlob);
      }
      if (isCrop) {
        processedBlob = await cropTransparent(processedBlob);
      }

      // Convert processed blob to base64 data URL
      const base64Data = await blobToBase64(processedBlob);

      // Suffix/filename logic
      const suffix = getIntelligentSuffix(item.prompt, i);
      const customName = (options.customFilenames && options.customFilenames[item.id]) || `${prefix}-${suffix}`;
      const fileExt = (isBgRemove || isCrop) ? 'png' : options.format;
      const filename = `${customName}.${fileExt}`;

      const itemMetadata = (options.customMetadata && options.customMetadata[item.id]) || options.metadata;

      // Use image name for all WP text fields
      const title = cleanTitle(customName);
      const author = authorNameInput.value.trim();

      const metadata = {
        title: title,
        alt_text: title,
        caption: '',
        description: '',
        filename: filename,
        author: author,
        author_name: author,
        country: itemMetadata?.country,
        state: itemMetadata?.state,
        city: itemMetadata?.city,
        sub_location: itemMetadata?.subLocation,
        latitude: itemMetadata?.gpsLatitude,
        longitude: itemMetadata?.gpsLongitude
      };

      const wpConfig = {
        siteUrl: settings.wpSiteUrl,
        apiKey: settings.wpApiKey
      };

      // Upload this item
      await uploadToWordPressMedia(wpConfig, base64Data, metadata);
    }

    showBanner('success', `Successfully uploaded ${completedItems.length} images to WordPress!`);
    alert(`Successfully uploaded ${completedItems.length} images to WordPress Media Library!`);
  } catch (err) {
    console.error('WP Upload Error:', err);
    showBanner('error', `WordPress Error: ${err instanceof Error ? err.message : err}`);
    alert(`Failed to upload to WordPress: ${err instanceof Error ? err.message : err}`);
  } finally {
    btnUploadWP.disabled = false;
    btnUploadWP.innerHTML = originalHTML;
  }
}

function cleanTitle(filename: string): string {
  const name = filename.replace(/\.[a-z0-9]+$/i, '');
  return name
    .split(/[-_]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function optimizeAltText(prompt: string): string {
  let clean = prompt.split(/[.\n🔹•\r\?]/)[0].trim();
  
  // Strip common starting phrases like "Create a... photo of a"
  clean = clean.replace(/^(create|generate|show)\s+(an?|the)?\s*[^]*?\b(photo|image|render|picture|graphic)\s+of\s+(an?|the)?/i, '');
  clean = clean.replace(/^(an?|the)?\s*[^]*?\b(photo|image|render|picture|graphic)\s+of\s+(an?|the)?/i, '');
  
  // Clean up any remaining leading spaces/punctuation
  clean = clean.trim().replace(/^[,;:\s]+/, '');

  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function showBanner(
  type: 'warning' | 'error' | 'success',
  text: string
): void {
  connectionBanner.className = `banner banner-${type}`;
  connectionText.textContent = text;
  connectionBanner.style.display = 'flex';
  
  if (type === 'warning') {
    btnOpenChatGPT.style.display = 'inline-block';
    if (text.toLowerCase().includes('gemini')) {
      btnOpenChatGPT.textContent = 'Open Gemini';
    } else {
      btnOpenChatGPT.textContent = 'Open ChatGPT';
    }
  } else {
    btnOpenChatGPT.style.display = 'none';
  }

  // Auto-hide success banners
  if (type === 'success') {
    setTimeout(() => {
      connectionBanner.style.display = 'none';
    }, 3000);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Message Listener ──────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage) => {
    if (message.type === MSG.QUEUE_STATUS_UPDATE) {
      const queue = message.payload as QueueData;
      if (viewQueue.style.display !== 'none' || viewBatch.style.display !== 'none') {
        renderQueue(queue);
      }
      // Auto-update provider select if changed in background
      settingsStorage.load().then((settings) => {
        if (providerSelect.value !== settings.activeProvider) {
          providerSelect.value = settings.activeProvider || 'chatgpt';
        }
      }).catch(() => {});
    } else if (message.type === 'LOG_ENTRY') {
      appendLogToPopup(message.payload as any);
    }
  }
);

// ─── Popup Log Utilities ───────────────────────────────────────

interface SimpleLog {
  timestamp: number;
  level: string;
  message: string;
  data?: Record<string, unknown>;
}

function appendLogToPopup(entry: SimpleLog): void {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const entryEl = document.createElement('div');
  entryEl.style.marginBottom = '6px';
  
  let extraText = '';
  if (entry.data) {
    try {
      // Keep html logging untruncated for complete DOM diagnostics
      const cleanData = { ...entry.data };
      if (typeof cleanData.html === 'string' && cleanData.html.length > 20000) {
        cleanData.html = cleanData.html.slice(0, 20000) + '… [TRUNCATED]';
      }
      extraText = `<pre style="margin:4px 0 0 12px; padding:6px; background:#27272a; border:1px solid #3f3f46; border-radius:4px; font-size:8px; color:#e4e4e7; max-height:100px; overflow:auto; white-space:pre-wrap; font-family:monospace;">${escapeHtml(JSON.stringify(cleanData, null, 2))}</pre>`;
    } catch {
      // ignore
    }
  }

  entryEl.innerHTML = `<div><span style="color:#71717a;">[${time}]</span> <span style="font-weight:bold; color:${entry.level === 'ERROR' ? '#ef4444' : entry.level === 'WARN' ? '#f59e0b' : '#3b82f6'};">[${entry.level}]</span> ${escapeHtml(entry.message)}</div>${extraText}`;
  
  // Clear placeholder
  if (debugLogsEntries.textContent === 'No log entries. Switch tabs or wait to see logs.') {
    debugLogsEntries.textContent = '';
  }

  debugLogsEntries.appendChild(entryEl);
  // Keep last 15 entries
  while (debugLogsEntries.children.length > 15) {
    debugLogsEntries.removeChild(debugLogsEntries.firstChild!);
  }
  // Scroll to bottom
  const container = document.getElementById('debug-logs');
  if (container) container.scrollTop = container.scrollHeight;
}

async function fetchLogsForPopup(): Promise<void> {
  try {
    const logs = await sendToBackground<SimpleLog[]>(MSG.GET_LOGS);
    if (logs && logs.length > 0) {
      debugLogsEntries.textContent = '';
      logs.slice(-15).forEach((entry) => {
        appendLogToPopup(entry);
      });
    }
  } catch {
    // ignore
  }
}

// ─── Initialization ────────────────────────────────────────────

async function loadActiveReferenceImage(): Promise<void> {
  try {
    const ref = await imageStore.get('ref-image-active');
    if (ref) {
      refImageStatus.textContent = ref.localFilename || 'product-reference.jpg';
      btnClearRef.style.display = 'inline-block';
    } else {
      refImageStatus.textContent = 'No image selected';
      btnClearRef.style.display = 'none';
    }
  } catch {
    refImageStatus.textContent = 'No image selected';
    btnClearRef.style.display = 'none';
  }
}

async function init(): Promise<void> {
  // Populate dropdown preset list first so it's always ready
  populateDeviceDropdown();

  // Load active reference image status
  await loadActiveReferenceImage();

  // Load debug logs
  fetchLogsForPopup();

  // Check for existing queue
  try {
    const queue = await sendToBackground<QueueData>(MSG.GET_QUEUE_STATUS);
    if (queue && queue.items && queue.items.length > 0) {
      currentQueue = queue;
      if (queue.state === 'completed') {
        const hasCompleted = queue.items.some((i) => i.status === 'completed');
        if (hasCompleted) {
          showBatchView(queue);
        } else {
          showView('queue');
          renderQueue(queue);
        }
      } else {
        showView('queue');
        renderQueue(queue);
      }
      return;
    }
  } catch {
    // No existing queue
  }

  // Show input view with default prompts from guide
  showView('input');
  
  const settings = await settingsStorage.load();
  providerSelect.value = settings.activeProvider || 'chatgpt';

  lastProductName = '[product]';
  productNameInput.value = '';
  DEFAULT_PROMPTS_TEMPLATES.forEach((tpl) => {
    addPromptField(tpl);
  });

  // Pre-configure defaults to follow guide specifications (JPG + 1200px)
  const jpgRadio = formatGroup.querySelector('input[value="jpg"]') as HTMLInputElement;
  if (jpgRadio) {
    jpgRadio.checked = true;
    formatGroup.querySelectorAll('.radio-option').forEach((o) => o.classList.remove('selected'));
    const parentLabel = jpgRadio.closest('.radio-option');
    if (parentLabel) parentLabel.classList.add('selected');
  }
  resolutionSelect.value = '1200x628';
  populateDeviceDropdown();
  updateFilenamePreview();
  updateExtensionPreviews();
}

// ─── Event Bindings ────────────────────────────────────────────

btnAddPrompt.addEventListener('click', () => addPromptField());
btnGenerate.addEventListener('click', handleGenerate);
btnClearPopupLogs.addEventListener('click', async () => {
  await sendToBackground(MSG.CLEAR_LOGS);
  debugLogsEntries.innerHTML = '<div style="color:var(--text-muted);">Logs cleared.</div>';
});

btnPause.addEventListener('click', () => sendToBackground(MSG.PAUSE_QUEUE));
btnResume.addEventListener('click', () => sendToBackground(MSG.RESUME_QUEUE));
btnCancel.addEventListener('click', () => sendToBackground(MSG.CANCEL_QUEUE));

const resetToInput = async () => {
  await sendToBackground(MSG.CLEAR_QUEUE);
  try {
    await imageStore.delete('ref-image-active');
    const allImages = await imageStore.getAll();
    for (const img of allImages) {
      if (img.id.startsWith('ref-image-prompt-')) {
        await imageStore.delete(img.id);
      }
    }
  } catch (err) {
    console.error('Failed to clear reference images:', err);
  }
  referenceImageInput.value = '';
  refImageStatus.textContent = 'No image selected';
  btnClearRef.style.display = 'none';
  
  currentQueue = null;
  promptCount = 0;
  promptsContainer.innerHTML = '';
  showView('input');
  lastProductName = '[product]';
  productNameInput.value = '';
  DEFAULT_PROMPTS_TEMPLATES.forEach((tpl) => {
    addPromptField(tpl);
  });

  // Pre-configure defaults to follow guide specifications (JPG + 1200px)
  const jpgRadio = formatGroup.querySelector('input[value="jpg"]') as HTMLInputElement;
  if (jpgRadio) {
    jpgRadio.checked = true;
    formatGroup.querySelectorAll('.radio-option').forEach((o) => o.classList.remove('selected'));
    const parentLabel = jpgRadio.closest('.radio-option');
    if (parentLabel) parentLabel.classList.add('selected');
  }
  resolutionSelect.value = '1200x628';
  updateFilenamePreview();
  updateExtensionPreviews();
};

btnNewBatch.addEventListener('click', resetToInput);
btnBackInput.addEventListener('click', resetToInput);

btnOpenChatGPT.addEventListener('click', async () => {
  const settings = await settingsStorage.load();
  if (settings.activeProvider === 'gemini') {
    sendToBackground(MSG.OPEN_GEMINI);
  } else {
    sendToBackground(MSG.OPEN_CHATGPT);
  }
  connectionBanner.style.display = 'none';
});

providerSelect.addEventListener('change', async () => {
  const settings = await settingsStorage.load();
  settings.activeProvider = providerSelect.value as 'chatgpt' | 'gemini';
  await settingsStorage.save(settings);
  await sendToBackground(MSG.SAVE_SETTINGS, { settings });
});

btnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

btnDownloadZip.addEventListener('click', handleDownloadZip);
btnUploadWP.addEventListener('click', handleUploadWP);
btnDownloadIndividual.addEventListener('click', async () => {
  btnDownloadIndividual.disabled = true;
  btnDownloadIndividual.innerHTML = '<div class="spinner"></div> Processing...';
  try {
    const options = getProcessingOptions();
    const result = await sendToBackground<{ success: boolean; error?: string }>(
      MSG.DOWNLOAD_INDIVIDUAL,
      { options }
    );
    if (!result?.success) {
      showBanner('error', result?.error || 'Failed to download individual images');
    }
  } catch (err) {
    showBanner('error', `Download error: ${err}`);
  } finally {
    btnDownloadIndividual.disabled = false;
    btnDownloadIndividual.innerHTML = 'Download Individual Images';
  }
});

// EXIF Toggle checkbox listener
exifToggle.addEventListener('change', () => {
  exifFieldsContainer.style.display = exifToggle.checked ? 'block' : 'none';
  updateFilenamePreview();
});

// EXIF Clear bulk button listener
btnClearExif.addEventListener('click', (e) => {
  e.preventDefault();
  
  exifMakeInput.value = '';
  exifModelInput.value = '';
  exifLensInput.value = '';
  exifSoftwareInput.value = '';
  exifCopyrightInput.value = '';
  exifDateInput.value = '';
  exifCountryInput.value = '';
  exifStateInput.value = '';
  exifCityInput.value = '';
  exifSublocInput.value = '';
  exifLatInput.value = '';
  exifLonInput.value = '';

  // Clear dataset values on cards
  const cards = batchImageList.querySelectorAll('.batch-image-item');
  cards.forEach((card) => {
    const cardEl = card as HTMLElement;
    delete cardEl.dataset.make;
    delete cardEl.dataset.model;
    delete cardEl.dataset.lensModel;
    delete cardEl.dataset.software;
    delete cardEl.dataset.copyright;
    delete cardEl.dataset.country;
    delete cardEl.dataset.state;
    delete cardEl.dataset.city;
    delete cardEl.dataset.subLocation;
    delete cardEl.dataset.gpsLatitude;
    delete cardEl.dataset.gpsLongitude;
    delete cardEl.dataset.dateTimeOriginal;
    
    const badge = cardEl.querySelector('.batch-image-device-badge');
    if (badge) {
      badge.textContent = '';
    }
  });
  
  updateFilenamePreview();
});

// EXIF Device select dropdown listener
exifDeviceSelect.addEventListener('change', () => {
  const val = exifDeviceSelect.value;
  if (!val) return;
  try {
    const device = JSON.parse(val) as DevicePreset;
    exifMakeInput.value = device.make;
    exifModelInput.value = device.model;
    exifLensInput.value = device.lensModel;
    exifSoftwareInput.value = device.software;
    
    // Choose a random location, author, date taken for global inputs
    const location = LOCATION_PRESETS[Math.floor(Math.random() * LOCATION_PRESETS.length)];
    const author = AUTHOR_PRESETS[Math.floor(Math.random() * AUTHOR_PRESETS.length)];
    exifCopyrightInput.value = `© 2026 ${author}`;
    exifDateInput.value = getRandomDateTime();
    exifCountryInput.value = location.country;
    exifStateInput.value = location.state;
    exifCityInput.value = location.city;
    exifSublocInput.value = location.subLocation;
    exifLatInput.value = location.lat;
    exifLonInput.value = location.lon;

    // Apply the selected device to ALL cards, but give each a random location/author/date
    const cards = batchImageList.querySelectorAll('.batch-image-item');
    cards.forEach((el) => {
      const cardEl = el as HTMLElement;
      const loc = LOCATION_PRESETS[Math.floor(Math.random() * LOCATION_PRESETS.length)];
      const cardAuthor = AUTHOR_PRESETS[Math.floor(Math.random() * AUTHOR_PRESETS.length)];
      cardEl.dataset.make = device.make;
      cardEl.dataset.model = device.model;
      cardEl.dataset.lensModel = device.lensModel;
      cardEl.dataset.software = device.software;
      cardEl.dataset.copyright = `© 2026 ${cardAuthor}`;
      cardEl.dataset.country = loc.country;
      cardEl.dataset.state = loc.state;
      cardEl.dataset.city = loc.city;
      cardEl.dataset.subLocation = loc.subLocation;
      cardEl.dataset.gpsLatitude = loc.lat;
      cardEl.dataset.gpsLongitude = loc.lon;
      cardEl.dataset.dateTimeOriginal = getRandomDateTime();
    });

    updateAllCardBadges();
  } catch (err) {
    console.error('Failed to parse selected device:', err);
  }
});

// EXIF Randomize devices listener — assigns unique metadata per card
btnRandomExif.addEventListener('click', (e) => {
  e.preventDefault();
  
  // Set global inputs to a random device (for the form display)
  const device = DEVICE_PRESETS[Math.floor(Math.random() * DEVICE_PRESETS.length)];
  const location = LOCATION_PRESETS[Math.floor(Math.random() * LOCATION_PRESETS.length)];
  const author = AUTHOR_PRESETS[Math.floor(Math.random() * AUTHOR_PRESETS.length)];
  const copyright = `© 2026 ${author}`;

  exifMakeInput.value = device.make;
  exifModelInput.value = device.model;
  exifLensInput.value = device.lensModel;
  exifSoftwareInput.value = device.software;
  exifCopyrightInput.value = copyright;
  exifDateInput.value = getRandomDateTime();
  exifCountryInput.value = location.country;
  exifStateInput.value = location.state;
  exifCityInput.value = location.city;
  exifSublocInput.value = location.subLocation;
  exifLatInput.value = location.lat;
  exifLonInput.value = location.lon;

  // Assign each card its own unique random device + location + author
  const cards = batchImageList.querySelectorAll('.batch-image-item');
  cards.forEach((el) => {
    randomizeCardExif(el as HTMLElement);
  });
  
  updateAllCardBadges();
});

// EXIF clear specific field listener
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const clearBtn = target.closest('.btn-clear-field');
  if (!clearBtn) return;
  
  e.preventDefault();
  const targetId = clearBtn.getAttribute('data-target');
  if (!targetId) return;
  
  const presetInput = document.getElementById(targetId) as HTMLInputElement | HTMLTextAreaElement;
  if (presetInput) {
    presetInput.value = '';
  }
  
  const fieldMap: Record<string, string> = {
    'exif-make': 'make',
    'exif-model': 'model',
    'exif-lens': 'lensModel',
    'exif-software': 'software',
    'exif-copyright': 'copyright',
    'exif-date': 'dateTimeOriginal',
    'exif-country': 'country',
    'exif-state': 'state',
    'exif-city': 'city',
    'exif-subloc': 'subLocation',
    'exif-lat': 'gpsLatitude',
    'exif-lon': 'gpsLongitude'
  };
  
  const attrName = fieldMap[targetId];
  if (!attrName) return;
  
  const cards = batchImageList.querySelectorAll('.batch-image-item');
  cards.forEach((card) => {
    const cardEl = card as HTMLElement;
    delete cardEl.dataset[attrName];
  });
  
  updateAllCardBadges();
  updateFilenamePreview();
});

// EXIF Advanced toggle listener
btnAdvancedExifToggle.addEventListener('click', (e) => {
  e.preventDefault();
  const isHidden = advancedExifFields.style.display === 'none';
  if (isHidden) {
    advancedExifFields.style.display = 'flex';
    advancedExifIcon.style.transform = 'rotate(45deg)';
    btnAdvancedExifToggle.style.color = 'var(--accent)';
  } else {
    advancedExifFields.style.display = 'none';
    advancedExifIcon.style.transform = 'rotate(0deg)';
    btnAdvancedExifToggle.style.color = 'var(--text-muted)';
  }
});
btnNewBatch.addEventListener('click', async () => {
  await sendToBackground(MSG.CLEAR_QUEUE);
  currentQueue = null;
  promptCount = 0;
  promptsContainer.innerHTML = '';
  showView('input');
  for (let i = 0; i < DEFAULT_PROMPT_COUNT; i++) {
    addPromptField();
  }
});

// Format radio buttons
formatGroup.querySelectorAll('.radio-option').forEach((option) => {
  option.addEventListener('click', () => {
    formatGroup.querySelectorAll('.radio-option').forEach((o) =>
      o.classList.remove('selected')
    );
    option.classList.add('selected');
    const radio = option.querySelector('input[type="radio"]') as HTMLInputElement;
    if (radio) radio.checked = true;
    updateFilenamePreview();
    updateExtensionPreviews();
  });
});

// Quality slider
qualityInput.addEventListener('input', () => {
  qualityValue.textContent = qualityInput.value;
});



// Filename preview updates
filenamePrefixInput.addEventListener('input', () => {
  updateIndividualNames();
  updateFilenamePreview();
});
resolutionSelect.addEventListener('change', updateFilenamePreview);

// Product Name input listener to dynamically update all textareas in real-time
productNameInput.addEventListener('input', () => {
  const newName = productNameInput.value.trim() || '[product]';
  if (newName === lastProductName) return;

  // Auto-slugify product name to populate Article Name input
  const productSlug = newName !== '[product]' ? slugify(newName) : '';
  if (productSlug) {
    articleNameInput.value = productSlug;
  }

  const textareas = promptsContainer.querySelectorAll('.prompt-textarea');
  const escapedLast = lastProductName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escapedLast, 'g');

  textareas.forEach((ta) => {
    const htmlTa = ta as HTMLTextAreaElement;
    htmlTa.value = htmlTa.value.replace(regex, newName);
  });

  lastProductName = newName;
});

// Reference Image Upload Event Listeners
btnUploadRef.addEventListener('click', (e) => {
  e.preventDefault();
  referenceImageInput.click();
});

referenceImageInput.addEventListener('change', async () => {
  const file = referenceImageInput.files?.[0];
  if (!file) return;

  refImageStatus.textContent = 'Storing image...';
  try {
    await imageStore.store('ref-image-active', file, undefined, undefined, file.name);
    refImageStatus.textContent = file.name;
    btnClearRef.style.display = 'inline-block';
  } catch (err) {
    console.error('Failed to store reference image:', err);
    refImageStatus.textContent = 'Upload failed';
    btnClearRef.style.display = 'none';
  }
});

btnClearRef.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await imageStore.delete('ref-image-active');
  } catch (err) {
    console.error('Failed to delete reference image:', err);
  }
  referenceImageInput.value = '';
  refImageStatus.textContent = 'No image selected';
  btnClearRef.style.display = 'none';
});

// Synchronize preset inputs real-time badge updates
[exifMakeInput, exifModelInput, exifCityInput, exifStateInput].forEach((input) => {
  input.addEventListener('input', () => {
    updateAllCardBadges();
  });
});


// ─── Helpers ───────────────────────────────────────────────────

interface DevicePreset {
  make: string;
  model: string;
  lensModel: string;
  software: string;
}

const DEVICE_PRESETS: DevicePreset[] = [
  // Apple
  { make: 'Apple', model: 'iPhone 15 Pro Max', lensModel: 'iPhone 15 Pro Max back camera 6.86mm f/1.78', software: 'iOS 17.5.1' },
  { make: 'Apple', model: 'iPhone 15 Pro', lensModel: 'iPhone 15 Pro back camera 6.86mm f/1.78', software: 'iOS 17.5.1' },
  { make: 'Apple', model: 'iPhone 15 Plus', lensModel: 'iPhone 15 Plus back camera 5.96mm f/1.6', software: 'iOS 17.5' },
  { make: 'Apple', model: 'iPhone 15', lensModel: 'iPhone 15 back camera 5.96mm f/1.6', software: 'iOS 17.5' },
  { make: 'Apple', model: 'iPhone 14 Pro Max', lensModel: 'iPhone 14 Pro Max back camera 6.86mm f/1.78', software: 'iOS 16.6' },
  { make: 'Apple', model: 'iPhone 14 Pro', lensModel: 'iPhone 14 Pro back camera 6.86mm f/1.78', software: 'iOS 16.6' },
  { make: 'Apple', model: 'iPhone 14 Plus', lensModel: 'iPhone 14 Plus back camera 5.7mm f/1.5', software: 'iOS 16.0' },
  { make: 'Apple', model: 'iPhone 14', lensModel: 'iPhone 14 back camera 5.7mm f/1.5', software: 'iOS 16.0' },
  { make: 'Apple', model: 'iPhone 13 Pro Max', lensModel: 'iPhone 13 Pro Max back camera 5.7mm f/1.5', software: 'iOS 15.7' },
  { make: 'Apple', model: 'iPhone 13 Pro', lensModel: 'iPhone 13 Pro back camera 5.7mm f/1.5', software: 'iOS 15.7' },
  { make: 'Apple', model: 'iPhone 13', lensModel: 'iPhone 13 back camera 5.1mm f/1.6', software: 'iOS 15.0' },
  { make: 'Apple', model: 'iPhone 13 mini', lensModel: 'iPhone 13 mini back camera 5.1mm f/1.6', software: 'iOS 15.0' },
  { make: 'Apple', model: 'iPhone 12 Pro Max', lensModel: 'iPhone 12 Pro Max back camera 5.1mm f/1.6', software: 'iOS 14.8' },
  { make: 'Apple', model: 'iPhone 12 Pro', lensModel: 'iPhone 12 Pro back camera 4.2mm f/1.6', software: 'iOS 14.8' },
  { make: 'Apple', model: 'iPhone 12', lensModel: 'iPhone 12 back camera 4.2mm f/1.6', software: 'iOS 14.1' },
  { make: 'Apple', model: 'iPhone 12 mini', lensModel: 'iPhone 12 mini back camera 4.2mm f/1.6', software: 'iOS 14.1' },
  { make: 'Apple', model: 'iPhone 11 Pro Max', lensModel: 'iPhone 11 Pro Max back camera 4.25mm f/1.8', software: 'iOS 13.7' },
  { make: 'Apple', model: 'iPhone 11 Pro', lensModel: 'iPhone 11 Pro back camera 4.25mm f/1.8', software: 'iOS 13.7' },
  { make: 'Apple', model: 'iPhone 11', lensModel: 'iPhone 11 back camera 4.25mm f/1.8', software: 'iOS 13.0' },
  { make: 'Apple', model: 'iPhone SE (3rd generation)', lensModel: 'iPhone SE back camera 3.99mm f/1.8', software: 'iOS 15.4' },
  { make: 'Apple', model: 'iPhone SE (2nd generation)', lensModel: 'iPhone SE back camera 3.99mm f/1.8', software: 'iOS 13.4' },
  { make: 'Apple', model: 'iPhone XS Max', lensModel: 'iPhone XS Max back camera 4.25mm f/1.8', software: 'iOS 12.4' },
  { make: 'Apple', model: 'iPhone XS', lensModel: 'iPhone XS back camera 4.25mm f/1.8', software: 'iOS 12.4' },
  { make: 'Apple', model: 'iPhone XR', lensModel: 'iPhone XR back camera 4.25mm f/1.8', software: 'iOS 12.0' },
  { make: 'Apple', model: 'iPhone X', lensModel: 'iPhone X back camera 4.0mm f/1.8', software: 'iOS 11.4' },
  { make: 'Apple', model: 'iPhone 8 Plus', lensModel: 'iPhone 8 Plus back camera 3.99mm f/1.8', software: 'iOS 11.0' },
  { make: 'Apple', model: 'iPhone 8', lensModel: 'iPhone 8 back camera 3.99mm f/1.8', software: 'iOS 11.0' },
  { make: 'Apple', model: 'iPhone 7 Plus', lensModel: 'iPhone 7 Plus back camera 3.99mm f/1.8', software: 'iOS 10.3' },
  { make: 'Apple', model: 'iPhone 7', lensModel: 'iPhone 7 back camera 3.99mm f/1.8', software: 'iOS 10.0' },

  // Samsung
  { make: 'Samsung', model: 'Galaxy S24 Ultra', lensModel: 'Galaxy S24 Ultra back camera 6.3mm f/1.7', software: 'Android 14 (One UI 6.1)' },
  { make: 'Samsung', model: 'Galaxy S24+', lensModel: 'Galaxy S24+ back camera 5.4mm f/1.8', software: 'Android 14 (One UI 6.1)' },
  { make: 'Samsung', model: 'Galaxy S24', lensModel: 'Galaxy S24 back camera 5.4mm f/1.8', software: 'Android 14 (One UI 6.1)' },
  { make: 'Samsung', model: 'Galaxy S23 Ultra', lensModel: 'Galaxy S23 Ultra back camera 6.3mm f/1.7', software: 'Android 13 (One UI 5.1)' },
  { make: 'Samsung', model: 'Galaxy S23+', lensModel: 'Galaxy S23+ back camera 5.4mm f/1.8', software: 'Android 13 (One UI 5.1)' },
  { make: 'Samsung', model: 'Galaxy S23', lensModel: 'Galaxy S23 back camera 5.4mm f/1.8', software: 'Android 13 (One UI 5.1)' },
  { make: 'Samsung', model: 'Galaxy S22 Ultra', lensModel: 'Galaxy S22 Ultra back camera 6.4mm f/1.8', software: 'Android 12 (One UI 4.1)' },
  { make: 'Samsung', model: 'Galaxy S22+', lensModel: 'Galaxy S22+ back camera 5.4mm f/1.8', software: 'Android 12 (One UI 4.1)' },
  { make: 'Samsung', model: 'Galaxy S22', lensModel: 'Galaxy S22 back camera 5.4mm f/1.8', software: 'Android 12 (One UI 4.1)' },
  { make: 'Samsung', model: 'Galaxy S21 Ultra 5G', lensModel: 'Galaxy S21 Ultra back camera 6.7mm f/1.8', software: 'Android 11 (One UI 3.1)' },
  { make: 'Samsung', model: 'Galaxy S21+ 5G', lensModel: 'Galaxy S21+ back camera 5.4mm f/1.8', software: 'Android 11 (One UI 3.1)' },
  { make: 'Samsung', model: 'Galaxy S21 5G', lensModel: 'Galaxy S21 back camera 5.4mm f/1.8', software: 'Android 11 (One UI 3.1)' },
  { make: 'Samsung', model: 'Galaxy S20 Ultra 5G', lensModel: 'Galaxy S20 Ultra back camera 7.0mm f/1.8', software: 'Android 10 (One UI 2.5)' },
  { make: 'Samsung', model: 'Galaxy S20+ 5G', lensModel: 'Galaxy S20+ back camera 5.4mm f/1.8', software: 'Android 10 (One UI 2.5)' },
  { make: 'Samsung', model: 'Galaxy S20 5G', lensModel: 'Galaxy S20 back camera 5.4mm f/1.8', software: 'Android 10 (One UI 2.5)' },
  { make: 'Samsung', model: 'Galaxy Z Fold5', lensModel: 'Galaxy Z Fold5 back camera 5.4mm f/1.8', software: 'Android 13 (One UI 5.1.1)' },
  { make: 'Samsung', model: 'Galaxy Z Flip5', lensModel: 'Galaxy Z Flip5 back camera 5.0mm f/1.8', software: 'Android 13 (One UI 5.1.1)' },
  { make: 'Samsung', model: 'Galaxy Z Fold4', lensModel: 'Galaxy Z Fold4 back camera 5.4mm f/1.8', software: 'Android 12L (One UI 4.1.1)' },
  { make: 'Samsung', model: 'Galaxy Z Flip4', lensModel: 'Galaxy Z Flip4 back camera 5.0mm f/1.8', software: 'Android 12 (One UI 4.1.1)' },
  { make: 'Samsung', model: 'Galaxy Note20 Ultra 5G', lensModel: 'Galaxy Note20 Ultra back camera 7.0mm f/1.8', software: 'Android 10 (One UI 2.5)' },
  { make: 'Samsung', model: 'Galaxy Note10+', lensModel: 'Galaxy Note10+ back camera 4.3mm f/1.5', software: 'Android 9 (One UI 1.5)' },

  // Google
  { make: 'Google', model: 'Pixel 8 Pro', lensModel: 'Pixel 8 Pro back camera 6.9mm f/1.68', software: 'Android 14' },
  { make: 'Google', model: 'Pixel 8', lensModel: 'Pixel 8 back camera 6.9mm f/1.68', software: 'Android 14' },
  { make: 'Google', model: 'Pixel 7 Pro', lensModel: 'Pixel 7 Pro back camera 6.81mm f/1.85', software: 'Android 13' },
  { make: 'Google', model: 'Pixel 7', lensModel: 'Pixel 7 back camera 6.81mm f/1.85', software: 'Android 13' },
  { make: 'Google', model: 'Pixel 7a', lensModel: 'Pixel 7a back camera 5.43mm f/1.89', software: 'Android 13' },
  { make: 'Google', model: 'Pixel 6 Pro', lensModel: 'Pixel 6 Pro back camera 6.81mm f/1.85', software: 'Android 12' },
  { make: 'Google', model: 'Pixel 6', lensModel: 'Pixel 6 back camera 6.81mm f/1.85', software: 'Android 12' },
  { make: 'Google', model: 'Pixel 6a', lensModel: 'Pixel 6a back camera 4.38mm f/1.73', software: 'Android 12' },
  { make: 'Google', model: 'Pixel 5', lensModel: 'Pixel 5 back camera 4.38mm f/1.7', software: 'Android 11' },
  { make: 'Google', model: 'Pixel 4a', lensModel: 'Pixel 4a back camera 4.38mm f/1.73', software: 'Android 10' },
  { make: 'Google', model: 'Pixel 4 XL', lensModel: 'Pixel 4 XL back camera 4.38mm f/1.73', software: 'Android 10' },
  { make: 'Google', model: 'Pixel 4', lensModel: 'Pixel 4 back camera 4.38mm f/1.73', software: 'Android 10' },

  // DSLR / Mirrorless
  { make: 'Sony', model: 'ILCE-7M4', lensModel: 'FE 24-70mm F2.8 GM II', software: 'ILCE-7M4 v2.01' },
  { make: 'Sony', model: 'ILCE-7M3', lensModel: 'FE 24-105mm F4 G OSS', software: 'ILCE-7M3 v4.01' },
  { make: 'Sony', model: 'ILCE-7RM5', lensModel: 'FE 50mm F1.2 GM', software: 'ILCE-7RM5 v2.00' },
  { make: 'Sony', model: 'ILCE-7RM4', lensModel: 'FE 35mm F1.4 GM', software: 'ILCE-7RM4 v1.20' },
  { make: 'Canon', model: 'Canon EOS R5', lensModel: 'RF24-70mm F2.8 L IS USM', software: 'Canon Firmware Version 1.8.0' },
  { make: 'Canon', model: 'Canon EOS R6', lensModel: 'RF50mm F1.2 L USM', software: 'Canon Firmware Version 1.8.0' },
  { make: 'Canon', model: 'Canon EOS R3', lensModel: 'RF24-105mm F4 L IS USM', software: 'Canon Firmware Version 1.4.0' },
  { make: 'Canon', model: 'Canon EOS 5D Mark IV', lensModel: 'EF24-70mm f/2.8L II USM', software: 'Canon Firmware Version 1.4.0' },
  { make: 'Nikon', model: 'NIKON Z 9', lensModel: 'NIKKOR Z 24-70mm f/2.8 S', software: 'Nikon Z 9 Firmware C:4.10' },
  { make: 'Nikon', model: 'NIKON Z 8', lensModel: 'NIKKOR Z 50mm f/1.2 S', software: 'Nikon Z 8 Firmware C:1.01' },
  { make: 'Nikon', model: 'NIKON D850', lensModel: 'AF-S NIKKOR 24-70mm f/2.8E ED VR', software: 'Nikon D850 Firmware C:1.30' },
  { make: 'Fujifilm', model: 'X-T5', lensModel: 'XF16-55mmF2.8 R LM WR', software: 'X-T5 Firmware 2.10' },
  { make: 'Fujifilm', model: 'X-T4', lensModel: 'XF18-55mmF2.8-4 R LM OIS', software: 'X-T4 Firmware 2.10' },
  { make: 'Fujifilm', model: 'X-H2S', lensModel: 'XF50-140mmF2.8 R LM OIS WR', software: 'X-H2S Firmware 3.10' }
];

interface LocationPreset {
  country: string;
  state: string;
  city: string;
  subLocation: string;
  lat: string;
  lon: string;
}

const LOCATION_PRESETS: LocationPreset[] = [
  { country: "United States", state: "Alaska", city: "Adak", subLocation: "Aleutians West", lat: "55.999722", lon: "-161.207778" },
  { country: "United States", state: "Alaska", city: "Akiachak", subLocation: "Bethel", lat: "60.891854", lon: "-161.39233" },
  { country: "United States", state: "Alaska", city: "Akiak", subLocation: "Bethel", lat: "60.890632", lon: "-161.199325" },
  { country: "United States", state: "Alaska", city: "Akutan", subLocation: "Aleutians East", lat: "54.143012", lon: "-165.785368" },
  { country: "United States", state: "Alaska", city: "Alakanuk", subLocation: "Kusilvak", lat: "62.746967", lon: "-164.60228" },
  { country: "United States", state: "Alaska", city: "Barrow", subLocation: "North Slope", lat: "71.234637", lon: "-156.817409" },
  { country: "United States", state: "Alaska", city: "Beaver", subLocation: "Yukon Koyukuk", lat: "66.33883", lon: "-147.279803" },
  { country: "United States", state: "Alaska", city: "Bethel", subLocation: "Bethel", lat: "60.832389", lon: "-161.824053" },
  { country: "United States", state: "Alaska", city: "Bettles Field", subLocation: "Yukon Koyukuk", lat: "67.100495", lon: "-151.062414" },
  { country: "United States", state: "Alaska", city: "Big Lake", subLocation: "Matanuska Susitna", lat: "61.5842", lon: "-149.4401" },
  { country: "United States", state: "Alaska", city: "Cantwell", subLocation: "Denali", lat: "63.395458", lon: "-148.89735" },
  { country: "United States", state: "Alaska", city: "Central", subLocation: "Yukon Koyukuk", lat: "65.468058", lon: "-144.74886" },
  { country: "United States", state: "Alaska", city: "Chalkyitsik", subLocation: "Yukon Koyukuk", lat: "66.719", lon: "-143.638121" },
  { country: "United States", state: "Alaska", city: "Chefornak", subLocation: "Bethel", lat: "60.153746", lon: "-164.210294" },
  { country: "United States", state: "Alaska", city: "Chevak", subLocation: "Kusilvak", lat: "61.583982", lon: "-164.776457" },
  { country: "United States", state: "Alaska", city: "Deering", subLocation: "Northwest Arctic", lat: "66.062265", lon: "-162.711951" },
  { country: "United States", state: "Alaska", city: "Delta Junction", subLocation: "Southeast Fairbanks", lat: "64.005426", lon: "-145.613611" },
  { country: "United States", state: "Alaska", city: "Denali National Park", subLocation: "Denali", lat: "63.516075", lon: "-149.539532" },
  { country: "United States", state: "Alaska", city: "Dillingham", subLocation: "Dillingham", lat: "59.059279", lon: "-158.973533" },
  { country: "United States", state: "Alaska", city: "Douglas", subLocation: "Juneau", lat: "58.275597", lon: "-134.395041" },
  { country: "United States", state: "Alaska", city: "Eagle", subLocation: "Southeast Fairbanks", lat: "64.783333", lon: "-141.2" },
  { country: "United States", state: "Alaska", city: "Eagle River", subLocation: "Anchorage", lat: "61.311357", lon: "-149.508515" },
  { country: "United States", state: "Alaska", city: "Eek", subLocation: "Bethel", lat: "60.215058", lon: "-162.032341" },
  { country: "United States", state: "Alaska", city: "Egegik", subLocation: "Lake And Peninsula", lat: "58.206174", lon: "-157.342202" },
  { country: "United States", state: "Alaska", city: "Eielson Afb", subLocation: "Fairbanks North Star", lat: "64.67352", lon: "-147.08051" },
  { country: "United States", state: "Alaska", city: "Fairbanks", subLocation: "Fairbanks North Star", lat: "64.840238", lon: "-147.710431" },
  { country: "United States", state: "Alaska", city: "False Pass", subLocation: "Aleutians East", lat: "54.841028", lon: "-163.436845" },
  { country: "United States", state: "Alaska", city: "Fort Greely", subLocation: "Southeast Fairbanks", lat: "64.036667", lon: "-145.733333" },
  { country: "United States", state: "Alaska", city: "Fort Richardson", subLocation: "Anchorage", lat: "61.275256", lon: "-149.675454" },
  { country: "United States", state: "Alaska", city: "Fort Wainwright", subLocation: "Fairbanks North Star", lat: "64.828303", lon: "-147.655673" },
  { country: "United States", state: "Alaska", city: "Gakona", subLocation: "Valdez Cordova", lat: "62.654744", lon: "-143.568393" },
  { country: "United States", state: "Alaska", city: "Galena", subLocation: "Yukon Koyukuk", lat: "64.760784", lon: "-156.797701" },
  { country: "United States", state: "Alaska", city: "Gambell", subLocation: "Nome", lat: "63.776555", lon: "-171.701685" },
  { country: "United States", state: "Alaska", city: "Girdwood", subLocation: "Anchorage", lat: "60.9425", lon: "-149.166389" },
  { country: "United States", state: "Alaska", city: "Glennallen", subLocation: "Valdez Cordova", lat: "62.103895", lon: "-145.661684" },
  { country: "United States", state: "Alaska", city: "Haines", subLocation: "Haines", lat: "59.251886", lon: "-135.542032" },
  { country: "United States", state: "Alaska", city: "Healy", subLocation: "Denali", lat: "63.917123", lon: "-149.011128" },
  { country: "United States", state: "Alaska", city: "Holy Cross", subLocation: "Yukon Koyukuk", lat: "62.192584", lon: "-159.825092" },
  { country: "United States", state: "Alaska", city: "Homer", subLocation: "Kenai Peninsula", lat: "59.665495", lon: "-151.462644" },
  { country: "United States", state: "Alaska", city: "Hoonah", subLocation: "Skagway Hoonah Angoon", lat: "58.032237", lon: "-135.558435" },
  { country: "United States", state: "Alaska", city: "Iliamna", subLocation: "Lake And Peninsula", lat: "59.564836", lon: "-155.462556" },
  { country: "United States", state: "Alaska", city: "Indian", subLocation: "Anchorage", lat: "60.9804", lon: "-149.4917" },
  { country: "United States", state: "Alabama", city: "Ider", subLocation: "De Kalb", lat: "34.735059", lon: "-85.641577" },
  { country: "United States", state: "Alabama", city: "Irvington", subLocation: "Mobile", lat: "30.480241", lon: "-88.239563" },
  { country: "United States", state: "Arkansas", city: "Ida", subLocation: "Cleburne", lat: "35.594326", lon: "-91.930081" },
  { country: "United States", state: "Alaska", city: "Juneau", subLocation: "Juneau", lat: "58.362767", lon: "-134.529429" },
  { country: "United States", state: "Alabama", city: "Jachin", subLocation: "Choctaw", lat: "32.244174", lon: "-88.233356" },
  { country: "United States", state: "Alabama", city: "Jack", subLocation: "Coffee", lat: "31.552392", lon: "-86.043083" },
  { country: "United States", state: "Alabama", city: "Jackson", subLocation: "Clarke", lat: "31.513098", lon: "-87.867192" },
  { country: "United States", state: "Alabama", city: "Jacksons Gap", subLocation: "Tallapoosa", lat: "32.879698", lon: "-85.848662" },
  { country: "United States", state: "Alaska", city: "Kake", subLocation: "Wrangell Petersburg", lat: "56.975833", lon: "-133.947222" },
  { country: "United States", state: "Alaska", city: "Kaktovik", subLocation: "North Slope", lat: "70.042889", lon: "-143.631329" },
  { country: "United States", state: "Alaska", city: "Kalskag", subLocation: "Bethel", lat: "61.541006", lon: "-160.3261" },
  { country: "United States", state: "Alaska", city: "Kaltag", subLocation: "Yukon Koyukuk", lat: "64.330452", lon: "-158.724251" },
  { country: "United States", state: "Alaska", city: "Karluk", subLocation: "Kodiak Island", lat: "57.57", lon: "-154.458333" },
  { country: "United States", state: "Alaska", city: "Lake Minchumina", subLocation: "Yukon Koyukuk", lat: "63.903884", lon: "-152.430081" },
  { country: "United States", state: "Alaska", city: "Larsen Bay", subLocation: "Kodiak Island", lat: "57.538333", lon: "-153.98" },
  { country: "United States", state: "Alaska", city: "Levelock", subLocation: "Lake And Peninsula", lat: "59.371395", lon: "-154.976815" },
  { country: "United States", state: "Alaska", city: "Lower Kalskag", subLocation: "Bethel", lat: "61.51377", lon: "-160.359966" },
  { country: "United States", state: "Alabama", city: "Laceys Spring", subLocation: "Morgan", lat: "34.499647", lon: "-86.612869" },
  { country: "United States", state: "Alaska", city: "Manley Hot Springs", subLocation: "Yukon Koyukuk", lat: "65.02058", lon: "-150.573267" },
  { country: "United States", state: "Alaska", city: "Manokotak", subLocation: "Dillingham", lat: "59.009559", lon: "-158.989699" },
  { country: "United States", state: "Alaska", city: "Marshall", subLocation: "Kusilvak", lat: "61.837087", lon: "-161.7394" },
  { country: "United States", state: "Alaska", city: "Mc Grath", subLocation: "Yukon Koyukuk", lat: "62.967153", lon: "-155.585153" },
  { country: "United States", state: "Alaska", city: "Mekoryuk", subLocation: "Bethel", lat: "60.365679", lon: "-166.283583" },
  { country: "United States", state: "Alaska", city: "Naknek", subLocation: "Bristol Bay", lat: "58.885699", lon: "-156.705405" },
  { country: "United States", state: "Alaska", city: "Napakiak", subLocation: "Bethel", lat: "60.663758", lon: "-161.738144" },
  { country: "United States", state: "Alaska", city: "Nenana", subLocation: "Yukon Koyukuk", lat: "64.557656", lon: "-149.086744" },
  { country: "United States", state: "Alaska", city: "New Stuyahok", subLocation: "Dillingham", lat: "59.593533", lon: "-157.297205" },
  { country: "United States", state: "Alaska", city: "Nightmute", subLocation: "Bethel", lat: "60.479444", lon: "-164.723889" },
  { country: "United States", state: "Alaska", city: "Old Harbor", subLocation: "Kodiak Island", lat: "57.202778", lon: "-153.303889" },
  { country: "United States", state: "Alaska", city: "Ouzinkie", subLocation: "Kodiak Island", lat: "57.925", lon: "-152.491667" },
  { country: "United States", state: "Alabama", city: "Oak Hill", subLocation: "Wilcox", lat: "31.925", lon: "-87.0825" },
  { country: "United States", state: "Alabama", city: "Oakman", subLocation: "Walker", lat: "33.700174", lon: "-87.368574" },
  { country: "United States", state: "Alabama", city: "Odenville", subLocation: "Saint Clair", lat: "33.675611", lon: "-86.408952" },
  { country: "United States", state: "Alaska", city: "Palmer", subLocation: "Matanuska Susitna", lat: "61.613814", lon: "-149.065323" },
  { country: "United States", state: "Alaska", city: "Pedro Bay", subLocation: "Lake And Peninsula", lat: "59.92238", lon: "-153.821856" },
  { country: "United States", state: "Alaska", city: "Pelican", subLocation: "Skagway Hoonah Angoon", lat: "57.960833", lon: "-136.2275" },
  { country: "United States", state: "Alaska", city: "Perryville", subLocation: "Lake And Peninsula", lat: "55.945289", lon: "-159.259333" },
  { country: "United States", state: "Alaska", city: "Petersburg", subLocation: "Wrangell Petersburg", lat: "56.827134", lon: "-133.160683" },
  { country: "United States", state: "Alaska", city: "Quinhagak", subLocation: "Bethel", lat: "59.738057", lon: "-161.874938" },
  { country: "United States", state: "Alabama", city: "Quinton", subLocation: "Walker", lat: "33.656065", lon: "-87.10066" },
  { country: "United States", state: "Arkansas", city: "Quitman", subLocation: "Cleburne", lat: "35.404988", lon: "-92.133334" },
  { country: "United States", state: "Arizona", city: "Quartzsite", subLocation: "La Paz", lat: "33.5675", lon: "-114.2731" },
  { country: "United States", state: "Arizona", city: "Queen Creek", subLocation: "Maricopa", lat: "33.238577", lon: "-111.643596" },
  { country: "United States", state: "Alaska", city: "Rampart", subLocation: "Yukon Koyukuk", lat: "65.383627", lon: "-150.011201" },
  { country: "United States", state: "Alaska", city: "Red Devil", subLocation: "Bethel", lat: "61.735389", lon: "-157.195969" },
  { country: "United States", state: "Alaska", city: "Ruby", subLocation: "Yukon Koyukuk", lat: "64.720062", lon: "-155.503872" },
  { country: "United States", state: "Alaska", city: "Russian Mission", subLocation: "Kusilvak", lat: "61.591302", lon: "-161.558413" },
  { country: "United States", state: "Alabama", city: "Ragland", subLocation: "Saint Clair", lat: "33.736677", lon: "-86.1619" },
  { country: "United States", state: "Alaska", city: "Saint George Island", subLocation: "Aleutians West", lat: "56.60324", lon: "-169.547257" },
  { country: "United States", state: "Alaska", city: "Saint Marys", subLocation: "Kusilvak", lat: "62.054106", lon: "-163.205263" },
  { country: "United States", state: "Alaska", city: "Saint Michael", subLocation: "Nome", lat: "63.47759", lon: "-162.109141" },
  { country: "United States", state: "Alaska", city: "Saint Paul Island", subLocation: "Aleutians West", lat: "57.178697", lon: "-170.293408" },
  { country: "United States", state: "Alaska", city: "Salcha", subLocation: "Fairbanks North Star", lat: "64.50905", lon: "-146.952974" },
  { country: "United States", state: "Alaska", city: "Takotna", subLocation: "Yukon Koyukuk", lat: "62.948889", lon: "-155.566389" },
  { country: "United States", state: "Alaska", city: "Talkeetna", subLocation: "Matanuska Susitna", lat: "62.260516", lon: "-150.110097" },
  { country: "United States", state: "Alaska", city: "Tanacross", subLocation: "Southeast Fairbanks", lat: "63.385278", lon: "-143.346389" },
  { country: "United States", state: "Alaska", city: "Tanana", subLocation: "Yukon Koyukuk", lat: "65.156483", lon: "-152.103747" },
  { country: "United States", state: "Alaska", city: "Tatitlek", subLocation: "Valdez Cordova", lat: "60.864722", lon: "-146.678611" },
  { country: "United States", state: "Alaska", city: "Unalakleet", subLocation: "Nome", lat: "63.883478", lon: "-160.788365" },
  { country: "United States", state: "Alaska", city: "Unalaska", subLocation: "Aleutians West", lat: "53.887114", lon: "-166.519855" },
  { country: "United States", state: "Alabama", city: "Union Grove", subLocation: "Marshall", lat: "34.409345", lon: "-86.462793" },
  { country: "United States", state: "Alabama", city: "Union Springs", subLocation: "Bullock", lat: "32.166252", lon: "-85.678746" },
  { country: "United States", state: "Alabama", city: "Uniontown", subLocation: "Perry", lat: "32.446966", lon: "-87.493398" },
  { country: "United States", state: "Alaska", city: "Valdez", subLocation: "Valdez Cordova", lat: "60.895044", lon: "-146.195628" },
  { country: "United States", state: "Alaska", city: "Venetie", subLocation: "Yukon Koyukuk", lat: "67.010446", lon: "-146.413723" },
  { country: "United States", state: "Alabama", city: "Valhermoso Springs", subLocation: "Morgan", lat: "34.538145", lon: "-86.678" },
  { country: "United States", state: "Alabama", city: "Valley", subLocation: "Chambers", lat: "32.811349", lon: "-85.174911" },
  { country: "United States", state: "Alabama", city: "Valley Head", subLocation: "De Kalb", lat: "34.5697", lon: "-85.627208" },
  { country: "United States", state: "Alaska", city: "Wainwright", subLocation: "North Slope", lat: "70.620064", lon: "-160.012532" },
  { country: "United States", state: "Alaska", city: "Wales", subLocation: "Nome", lat: "65.688212", lon: "-168.520521" },
  { country: "United States", state: "Alaska", city: "Ward Cove", subLocation: "Ketchikan Gateway", lat: "55.408333", lon: "-131.725" },
  { country: "United States", state: "Alaska", city: "Wasilla", subLocation: "Matanuska Susitna", lat: "61.5814", lon: "-149.4394" },
  { country: "United States", state: "Alaska", city: "White Mountain", subLocation: "Nome", lat: "64.702791", lon: "-163.42185" },
  { country: "United States", state: "Illinois", city: "Xenia", subLocation: "Clay", lat: "38.669747", lon: "-88.63789" },
  { country: "United States", state: "Alaska", city: "Yakutat", subLocation: "Yakutat", lat: "59.620211", lon: "-139.778858" },
  { country: "United States", state: "Alabama", city: "York", subLocation: "Sumter", lat: "32.472765", lon: "-88.268304" },
  { country: "United States", state: "Arkansas", city: "Yellville", subLocation: "Marion", lat: "36.225322", lon: "-92.724472" },
  { country: "United States", state: "Arkansas", city: "Yorktown", subLocation: "Lincoln", lat: "34.017166", lon: "-91.796472" },
  { country: "United States", state: "Arizona", city: "Yarnell", subLocation: "Yavapai", lat: "34.414076", lon: "-112.62166" },
  { country: "United States", state: "California", city: "Zamora", subLocation: "Yolo", lat: "38.799896", lon: "-121.90654" },
  { country: "United States", state: "California", city: "Zenia", subLocation: "Trinity", lat: "40.205556", lon: "-123.490833" },
  { country: "United States", state: "Florida", city: "Zellwood", subLocation: "Orange", lat: "28.71944", lon: "-81.576174" },
  { country: "United States", state: "Florida", city: "Zephyrhills", subLocation: "Pasco", lat: "28.2333", lon: "-82.1813" },
  { country: "United States", state: "Florida", city: "Zolfo Springs", subLocation: "Hardee", lat: "27.480042", lon: "-81.742328" }
];

const AUTHOR_PRESETS = [
  'Marcus Chen',
  'Emma Lycoris',
  'Sarah Jenkins',
  'David Miller',
  'Hiroshi Tanaka',
  'Sophia Rossi',
  'Lucas Fischer',
  'Elena Petrova',
  'Alex Mercer',
  'Chloe Dubois'
];

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

function randomizeCardExif(cardEl: HTMLElement) {
  const device = DEVICE_PRESETS[Math.floor(Math.random() * DEVICE_PRESETS.length)];
  const location = LOCATION_PRESETS[Math.floor(Math.random() * LOCATION_PRESETS.length)];
  const author = AUTHOR_PRESETS[Math.floor(Math.random() * AUTHOR_PRESETS.length)];
  const copyright = `© 2026 ${author}`;

  cardEl.dataset.make = device.make;
  cardEl.dataset.model = device.model;
  cardEl.dataset.lensModel = device.lensModel;
  cardEl.dataset.software = device.software;
  cardEl.dataset.copyright = copyright;
  cardEl.dataset.country = location.country;
  cardEl.dataset.state = location.state;
  cardEl.dataset.city = location.city;
  cardEl.dataset.subLocation = location.subLocation;
  cardEl.dataset.gpsLatitude = location.lat;
  cardEl.dataset.gpsLongitude = location.lon;
  cardEl.dataset.dateTimeOriginal = getRandomDateTime();
  
  const badge = cardEl.querySelector('.batch-image-device-badge');
  if (badge) {
    badge.textContent = `📷 ${device.make} ${device.model} (${location.city}, ${location.state})`;
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // remove non-word chars
    .replace(/[\s_]+/g, '-')   // replace spaces/underscores with dashes
    .replace(/-+/g, '-')       // collapse consecutive dashes
    .trim();
}

function getIntelligentSuffix(prompt: string, index: number): string {
  const p = prompt.toLowerCase();
  if (p.includes('being used') || p.includes('in use') || p.includes('capsule next to a hand') || p.includes('bottle next to a hand')) {
    return 'in-use';
  }
  if (p.includes('hand holding') || p.includes('in hand') || p.includes('holding a product')) {
    return 'in-hand';
  }
  if (p.includes('unboxed') || p.includes('unboxing') || p.includes('shipping package') || p.includes('evidence of the original')) {
    return 'unboxing';
  }
  if (p.includes('before and after') || p.includes('before & after') || p.includes('comparison')) {
    return 'before-after';
  }
  if (p.includes('background removed') || p.includes('feature image') || p.includes('white background') && p.includes('300x300')) {
    return 'feature-image';
  }
  return String(index + 1).padStart(2, '0');
}

function populateDeviceDropdown(): void {
  exifDeviceSelect.innerHTML = '';
  
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.disabled = true;
  defaultOpt.selected = true;
  defaultOpt.textContent = 'Select a device profile...';
  exifDeviceSelect.appendChild(defaultOpt);

  const groups: Record<string, DevicePreset[]> = {
    'Apple (iOS)': DEVICE_PRESETS.filter((d) => d.make === 'Apple'),
    'Samsung (Android)': DEVICE_PRESETS.filter((d) => d.make === 'Samsung'),
    'Google (Android)': DEVICE_PRESETS.filter((d) => d.make === 'Google'),
    'Popular DSLR / Mirrorless': DEVICE_PRESETS.filter(
      (d) => d.make !== 'Apple' && d.make !== 'Samsung' && d.make !== 'Google'
    ),
  };

  for (const [groupName, presets] of Object.entries(groups)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupName;
    
    presets.forEach((preset) => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(preset);
      opt.textContent = preset.model;
      optgroup.appendChild(opt);
    });
    
    exifDeviceSelect.appendChild(optgroup);
  }
}

function updateAllCardBadges(): void {
  const cards = batchImageList.querySelectorAll('.batch-image-item');
  const presetMake = exifMakeInput.value.trim();
  const presetModel = exifModelInput.value.trim();
  const presetCity = exifCityInput.value.trim();
  const presetState = exifStateInput.value.trim();
  
  cards.forEach((card) => {
    const cardEl = card as HTMLElement;
    const make = cardEl.dataset.make !== undefined ? cardEl.dataset.make : presetMake;
    const model = cardEl.dataset.model !== undefined ? cardEl.dataset.model : presetModel;
    const city = cardEl.dataset.city !== undefined ? cardEl.dataset.city : presetCity;
    const state = cardEl.dataset.state !== undefined ? cardEl.dataset.state : presetState;
    
    const badge = cardEl.querySelector('.batch-image-device-badge') as HTMLElement;
    if (badge) {
      if (make || model) {
        const fullText = `📷 ${make} ${model}` + (city || state ? ` (${city}${city && state ? ', ' : ''}${state})` : '');
        badge.textContent = fullText;
        badge.title = fullText;
        badge.style.display = 'inline-block';
      } else {
        badge.textContent = '';
        badge.title = '';
        badge.style.display = 'none';
      }
    }
  });
}



async function fillBackgroundColorClient(blob: Blob, hexColor: string): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = hexColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      canvas.toBlob((outBlob) => {
        resolve(outBlob || blob);
      }, 'image/png');
    };
    img.onerror = () => {
      resolve(blob);
    };
  });
}

// Init
init();
