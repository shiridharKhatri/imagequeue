import type { LogEntry, LogLevel } from './types';
import { MAX_LOG_ENTRIES, PROMPT_PREVIEW_LENGTH, STORAGE_KEY_LOGS } from './constants';

/**
 * Structured logger that stores recent entries in chrome.storage.local
 * and optionally broadcasts them to the popup via runtime messaging.
 */
class Logger {
  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Format a timestamp for display */
  private formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false });
  }

  /** Truncate a prompt for safe logging */
  truncatePrompt(prompt: string): string {
    if (prompt.length <= PROMPT_PREVIEW_LENGTH) return prompt;
    return prompt.slice(0, PROMPT_PREVIEW_LENGTH) + '…';
  }

  /** Create and store a log entry */
  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    // If in popup, options, or offscreen document, delegate to background service worker
    if (typeof window !== 'undefined') {
      try {
        const text = message + (data ? ' ' + JSON.stringify(data) : '');
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_LOG',
          payload: { text, level: level.toLowerCase() }
        }).catch(() => {});
      } catch {
        // Fallback
      }

      // Console output in local context
      const prefix = `[${this.formatTime(Date.now())}] [${level}]`;
      const consoleMethod = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
      console[consoleMethod](prefix, message, data ?? '');
      return;
    }

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      data,
    };

    this.buffer.push(entry);

    // Console output
    const prefix = `[${this.formatTime(entry.timestamp)}] [${level}]`;
    const consoleMethod = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
    console[consoleMethod](prefix, message, data ?? '');

    // Broadcast to popup (best-effort, ignore if no listener)
    try {
      chrome.runtime.sendMessage({
        type: 'LOG_ENTRY',
        payload: entry,
      }).catch(() => { /* popup may be closed */ });
    } catch {
      // Messaging unavailable (e.g., in test env)
    }

    // Debounced flush to storage
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 1000);
  }

  /** Persist buffered entries to chrome.storage.local */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_LOGS);
      const existing: LogEntry[] = result[STORAGE_KEY_LOGS] ?? [];
      const merged = [...existing, ...this.buffer].slice(-MAX_LOG_ENTRIES);
      this.buffer = [];
      await chrome.storage.local.set({ [STORAGE_KEY_LOGS]: merged });
    } catch (err) {
      console.error('Failed to flush logs:', err);
    }
  }

  /** Retrieve all stored log entries */
  async getAll(): Promise<LogEntry[]> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_LOGS);
      return result[STORAGE_KEY_LOGS] ?? [];
    } catch {
      return [];
    }
  }

  /** Clear all stored logs */
  async clear(): Promise<void> {
    this.buffer = [];
    try {
      await chrome.storage.local.remove(STORAGE_KEY_LOGS);
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  }

  // ─── Convenience methods ─────────────────────────────────────

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('DEBUG', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('INFO', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('WARN', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('ERROR', message, data);
  }
}

/** Singleton logger instance */
export const logger = new Logger();
