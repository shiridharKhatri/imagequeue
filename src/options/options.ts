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
const zipOnWPUploadCheckbox = $<HTMLInputElement>('zip-on-wp-upload');

// WordPress Settings
const wpSiteUrlInput = $<HTMLInputElement>('wp-site-url');
const wpApiKeyInput = $<HTMLInputElement>('wp-api-key');
const defaultAuthorInput = $<HTMLInputElement>('default-author');
const customBgRemovalUrlInput = $<HTMLInputElement>('custom-bg-removal-url');
const imageProcessingModeSelect = $<HTMLSelectElement>('image-processing-mode');

// Google Drive Settings
const gdriveEnabledCheckbox = $<HTMLInputElement>('gdrive-enabled');
const gdriveClientIdInput = $<HTMLInputElement>('gdrive-client-id');
const gdriveClientSecretInput = $<HTMLInputElement>('gdrive-client-secret');
const gdriveFolderIdInput = $<HTMLInputElement>('gdrive-folder-id');
const gdriveManualAccessTokenInput = $<HTMLInputElement>('gdrive-manual-access-token');
const gdriveManualRefreshTokenInput = $<HTMLInputElement>('gdrive-manual-refresh-token');
const btnAuthGDrive = $<HTMLButtonElement>('btn-auth-gdrive');
const btnCopyRedirect = $<HTMLButtonElement>('btn-copy-redirect');
const gdriveRedirectUriInput = $<HTMLInputElement>('gdrive-redirect-uri');

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
  zipOnWPUploadCheckbox.checked = settings.zipOnWPUpload || false;

  wpSiteUrlInput.value = settings.wpSiteUrl || '';
  wpApiKeyInput.value = settings.wpApiKey || '';
  defaultAuthorInput.value = settings.authorName || '';
  customBgRemovalUrlInput.value = settings.customBgRemovalUrl || '';
  imageProcessingModeSelect.value = settings.imageProcessingMode || 'local';

  // Google Drive
  gdriveEnabledCheckbox.checked = settings.gdriveEnabled || false;
  gdriveClientIdInput.value = settings.gdriveClientId || '';
  gdriveClientSecretInput.value = settings.gdriveClientSecret || '';
  gdriveFolderIdInput.value = settings.gdriveFolderId || '';
  gdriveManualAccessTokenInput.value = settings.gdriveAccessToken || '';
  gdriveManualRefreshTokenInput.value = settings.gdriveRefreshToken || '';
  updateGDriveStatus(settings);
}

function updateGDriveStatus(settings: ExtensionSettings): void {
  const infoEl = $('gdrive-status-info');
  if (!infoEl) return;
  if (settings.gdriveUserEmail) {
    infoEl.textContent = `Connected as ${settings.gdriveUserEmail}`;
    infoEl.style.color = '#22c55e'; // green
  } else if (settings.gdriveAccessToken) {
    infoEl.textContent = 'Connected (Manual Token)';
    infoEl.style.color = '#3b82f6'; // blue
  } else {
    infoEl.textContent = 'Not authenticated';
    infoEl.style.color = '#a1a1aa'; // muted
  }
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
    zipOnWPUpload: zipOnWPUploadCheckbox.checked,
    deleteAfterZip: deleteAfterZipCheckbox.checked,
    wpEnabled: true,
    wpSiteUrl: wpSiteUrlInput.value.trim(),
    wpApiKey: wpApiKeyInput.value.trim(),
    authorName: defaultAuthorInput.value.trim(),
    customBgRemovalUrl: customBgRemovalUrlInput.value.trim(),
    imageProcessingMode: imageProcessingModeSelect.value as 'local' | 'api',
    gdriveEnabled: gdriveEnabledCheckbox.checked,
    gdriveClientId: gdriveClientIdInput.value.trim(),
    gdriveClientSecret: gdriveClientSecretInput.value.trim(),
    gdriveFolderId: gdriveFolderIdInput.value.trim(),
    gdriveAccessToken: gdriveManualAccessTokenInput.value.trim(),
    gdriveRefreshToken: gdriveManualRefreshTokenInput.value.trim(),
    gdriveUserEmail: currentSettings?.gdriveUserEmail || '',
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

// Initialize Redirect URI
try {
  gdriveRedirectUriInput.value = chrome.identity?.getRedirectURL ? chrome.identity.getRedirectURL() : `https://${chrome.runtime.id}.chromiumapp.org/`;
} catch (e) {
  gdriveRedirectUriInput.value = `https://${chrome.runtime.id}.chromiumapp.org/`;
}

btnCopyRedirect.addEventListener('click', () => {
  navigator.clipboard.writeText(gdriveRedirectUriInput.value);
  btnCopyRedirect.textContent = 'Copied!';
  setTimeout(() => {
    btnCopyRedirect.textContent = 'Copy';
  }, 2000);
});

btnAuthGDrive.addEventListener('click', async () => {
  const clientId = gdriveClientIdInput.value.trim();
  const clientSecret = gdriveClientSecretInput.value.trim();
  if (!clientId || !clientSecret) {
    alert('Please enter both Google Client ID and Google Client Secret before authenticating.');
    return;
  }

  btnAuthGDrive.disabled = true;
  btnAuthGDrive.textContent = 'Authenticating...';
  
  try {
    const redirectUri = gdriveRedirectUriInput.value;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=https://www.googleapis.com/auth/drive.file%20https://www.googleapis.com/auth/userinfo.email&access_type=offline&prompt=consent`;

    chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    }, async (responseUrl) => {
      const err = chrome.runtime.lastError;
      if (err || !responseUrl) {
        alert(`Authentication failed: ${err ? err.message : 'No response URL received'}`);
        btnAuthGDrive.disabled = false;
        btnAuthGDrive.textContent = 'Authenticate with Google';
        return;
      }

      try {
        const urlObj = new URL(responseUrl);
        const code = urlObj.searchParams.get('code');
        if (!code) {
          throw new Error('Authorization code not found in response URL');
        }

        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
          })
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          throw new Error(`Token exchange failed: ${errText}`);
        }

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;

        // Fetch user email
        const emailRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        
        let email = 'unknown-user';
        if (emailRes.ok) {
          const emailData = await emailRes.json();
          email = emailData.email || email;
        }

        // Update inputs
        gdriveManualAccessTokenInput.value = accessToken;
        if (refreshToken) {
          gdriveManualRefreshTokenInput.value = refreshToken;
        }

        // Save immediately
        const currentSettings = await sendToBackground<ExtensionSettings>(MSG.GET_SETTINGS);
        const settings: ExtensionSettings = {
          ...currentSettings!,
          gdriveEnabled: true,
          gdriveClientId: clientId,
          gdriveClientSecret: clientSecret,
          gdriveFolderId: gdriveFolderIdInput.value.trim(),
          gdriveAccessToken: accessToken,
          gdriveRefreshToken: refreshToken || currentSettings?.gdriveRefreshToken || '',
          gdriveUserEmail: email
        };

        await sendToBackground(MSG.SAVE_SETTINGS, { settings });
        updateGDriveStatus(settings);
        
        // Check checkbox
        gdriveEnabledCheckbox.checked = true;

        alert(`Successfully authenticated as ${email}! Settings saved.`);
      } catch (ex: any) {
        alert(`Error during token exchange: ${ex.message}`);
      } finally {
        btnAuthGDrive.disabled = false;
        btnAuthGDrive.textContent = 'Authenticate with Google';
      }
    });
  } catch (err: any) {
    alert(`Authentication initialization failed: ${err.message}`);
    btnAuthGDrive.disabled = false;
    btnAuthGDrive.textContent = 'Authenticate with Google';
  }
});

// ─── Init ──────────────────────────────────────────────────────
loadSettings();
refreshDiagnostics();
refreshLogs();
