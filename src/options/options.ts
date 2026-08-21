import { MSG, sendToBackground } from '../shared/messages';
import type { ExtensionSettings, DiagnosticsInfo, LogEntry } from '../shared/types';

// ─── DOM References ────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// Settings inputs
const chatgptDomainInput = $<HTMLInputElement>('chatgpt-domain');
const geminiDomainInput = $<HTMLInputElement>('gemini-domain');
const maxRetriesInput = $<HTMLInputElement>('max-retries');
const genTimeoutInput = $<HTMLInputElement>('gen-timeout');
const pauseOnFailureCheckbox = $<HTMLInputElement>('pause-on-failure');
const defaultFormatSelect = $<HTMLSelectElement>('default-format');
const defaultQualityInput = $<HTMLInputElement>('default-quality');
const defaultResolutionSelect = $<HTMLSelectElement>('default-resolution');
const defaultPrefixInput = $<HTMLInputElement>('default-prefix');
const autoZipCheckbox = $<HTMLInputElement>('auto-zip');
const deleteAfterZipCheckbox = $<HTMLInputElement>('delete-after-zip');

// WordPress Settings
const wpSiteUrlInput = $<HTMLInputElement>('wp-site-url');
const wpApiKeyInput = $<HTMLInputElement>('wp-api-key');
const defaultAuthorInput = $<HTMLInputElement>('default-author');

// Diagnostics
const diagTab = $<HTMLElement>('diag-tab');
const diagReady = $<HTMLElement>('diag-ready');
const diagWorker = $<HTMLElement>('diag-worker');
const diagDownloads = $<HTMLElement>('diag-downloads');
const diagStorage = $<HTMLElement>('diag-storage');

// Logs
const logsContainer = $<HTMLElement>('logs');
const saveStatus = $<HTMLElement>('save-status');

// ─── Load Settings ─────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  const settings = await sendToBackground<ExtensionSettings>(MSG.GET_SETTINGS);
  if (!settings) return;

  chatgptDomainInput.value = settings.chatgptDomain;
  geminiDomainInput.value = settings.geminiDomain || 'gemini.google.com';
  maxRetriesInput.value = String(settings.maxRetries);
  genTimeoutInput.value = String(settings.generationTimeoutMs / 1000);
  pauseOnFailureCheckbox.checked = settings.pauseOnFailure;
  defaultFormatSelect.value = settings.defaultFormat;
  defaultQualityInput.value = String(settings.defaultQuality);
  defaultResolutionSelect.value = settings.defaultResolution || '0';
  defaultPrefixInput.value = settings.defaultFilenamePrefix;
  autoZipCheckbox.checked = settings.autoZipOnComplete;
  deleteAfterZipCheckbox.checked = settings.deleteAfterZip;

  wpSiteUrlInput.value = settings.wpSiteUrl || '';
  wpApiKeyInput.value = settings.wpApiKey || '';
  defaultAuthorInput.value = settings.authorName || '';
}

async function saveSettings(): Promise<void> {
  const currentSettings = await sendToBackground<ExtensionSettings>(MSG.GET_SETTINGS);
  const settings: ExtensionSettings = {
    activeProvider: currentSettings?.activeProvider || 'chatgpt',
    chatgptDomain: chatgptDomainInput.value.trim() || 'chatgpt.com',
    geminiDomain: geminiDomainInput.value.trim() || 'gemini.google.com',
    newConversationPerPrompt: false,
    maxRetries: parseInt(maxRetriesInput.value) || 3,
    generationTimeoutMs: (parseInt(genTimeoutInput.value) || 120) * 1000,
    pauseOnFailure: pauseOnFailureCheckbox.checked,
    defaultFormat: defaultFormatSelect.value as ExtensionSettings['defaultFormat'],
    defaultQuality: parseInt(defaultQualityInput.value) || 90,
    defaultResolution: defaultResolutionSelect.value,
    defaultFilenamePrefix: defaultPrefixInput.value.trim() || 'image',
    autoZipOnComplete: autoZipCheckbox.checked,
    deleteAfterZip: deleteAfterZipCheckbox.checked,
    wpEnabled: true,
    wpSiteUrl: wpSiteUrlInput.value.trim(),
    wpApiKey: wpApiKeyInput.value.trim(),
    authorName: defaultAuthorInput.value.trim(),
  };

  await sendToBackground(MSG.SAVE_SETTINGS, { settings });

  saveStatus.textContent = '✓ Saved';
  setTimeout(() => {
    saveStatus.textContent = '';
  }, 2000);
}

// ─── Diagnostics ───────────────────────────────────────────────

async function refreshDiagnostics(): Promise<void> {
  const diag = await sendToBackground<DiagnosticsInfo>(MSG.GET_DIAGNOSTICS);
  if (!diag) return;

  setDiagValue(diagTab, diag.chatgptTabDetected, 'YES', 'NO');
  setDiagValue(diagReady, diag.chatgptReady, 'YES', 'NO');
  setDiagValue(diagWorker, diag.queueWorkerRunning, 'RUNNING', 'STOPPED');
  setDiagValue(diagDownloads, diag.downloadsPermission, 'OK', 'ERROR');
  diagStorage.textContent = formatBytes(diag.storageUsedBytes);
  diagStorage.className = 'diag-value';
}

function setDiagValue(
  el: HTMLElement,
  ok: boolean,
  yesText: string,
  noText: string
): void {
  el.textContent = ok ? yesText : noText;
  el.className = `diag-value ${ok ? 'ok' : 'error'}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ─── Logs ───────────────────────────────────────────────────── 

async function refreshLogs(): Promise<void> {
  const logs = await sendToBackground<LogEntry[]>(MSG.GET_LOGS);
  if (!logs || logs.length === 0) {
    logsContainer.innerHTML = '<div class="log-empty">No log entries</div>';
    return;
  }

  const visibleLogs = logs.filter((entry) => entry.level !== 'DEBUG');
  if (visibleLogs.length === 0) {
    logsContainer.innerHTML = '<div class="log-empty">No log entries</div>';
    return;
  }

  logsContainer.innerHTML = visibleLogs
    .slice(-50)
    .reverse()
    .map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
      });
      return `<div class="log-entry"><span class="time">[${time}]</span> <span class="level-${entry.level}">[${entry.level}]</span> ${escapeHtml(entry.message)}</div>`;
    })
    .join('');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Event Bindings ────────────────────────────────────────────

$<HTMLButtonElement>('btn-save').addEventListener('click', saveSettings);
$<HTMLButtonElement>('btn-refresh-diag').addEventListener('click', refreshDiagnostics);
$<HTMLButtonElement>('btn-refresh-logs').addEventListener('click', refreshLogs);
$<HTMLButtonElement>('btn-clear-logs').addEventListener('click', async () => {
  await sendToBackground(MSG.CLEAR_LOGS);
  logsContainer.innerHTML = '<div class="log-empty">No log entries</div>';
});

// Tab switching logic for the sidebar menu
const navItems = document.querySelectorAll('.nav-item');
const tabs = document.querySelectorAll('.tab-content');

navItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    navItems.forEach((b) => b.classList.remove('active'));
    tabs.forEach((t) => t.classList.remove('active'));

    btn.classList.add('active');
    const targetTab = btn.getAttribute('data-tab');
    if (targetTab) {
      document.getElementById(targetTab)?.classList.add('active');
    }
  });
});

// ─── Init ──────────────────────────────────────────────────────

loadSettings();
refreshDiagnostics();
refreshLogs();
