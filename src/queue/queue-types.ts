import type { QueueItem, QueueItemStatus, QueueState } from '../shared/types';

/**
 * Create a new queue item from a prompt string.
 */
export function createQueueItem(prompt: string, refImageKey?: string): QueueItem {
  return {
    id: crypto.randomUUID(),
    prompt,
    status: 'queued',
    retryCount: 0,
    createdAt: Date.now(),
    refImageKey,
  };
}

/**
 * Status display info for the UI.
 */
export interface StatusDisplay {
  icon: string;
  label: string;
  color: string;
}

export const STATUS_DISPLAY: Record<QueueItemStatus, StatusDisplay> = {
  queued: { icon: '○', label: 'Waiting', color: '#888' },
  generating: { icon: '⏳', label: 'Generating', color: '#f0a030' },
  completed: { icon: '✓', label: 'Completed', color: '#4caf50' },
  failed: { icon: '✕', label: 'Failed', color: '#e53935' },
  cancelled: { icon: '⊘', label: 'Cancelled', color: '#999' },
};

/**
 * Compute aggregate queue stats for progress display.
 */
export interface QueueStats {
  total: number;
  completed: number;
  failed: number;
  generating: number;
  queued: number;
  cancelled: number;
  progressPercent: number;
}

export function computeQueueStats(items: QueueItem[]): QueueStats {
  const stats: QueueStats = {
    total: items.length,
    completed: 0,
    failed: 0,
    generating: 0,
    queued: 0,
    cancelled: 0,
    progressPercent: 0,
  };

  for (const item of items) {
    switch (item.status) {
      case 'completed': stats.completed++; break;
      case 'failed': stats.failed++; break;
      case 'generating': stats.generating++; break;
      case 'queued': stats.queued++; break;
      case 'cancelled': stats.cancelled++; break;
    }
  }

  if (stats.total > 0) {
    stats.progressPercent = Math.round(
      ((stats.completed + stats.failed + stats.cancelled) / stats.total) * 100
    );
  }

  return stats;
}

/**
 * Determine if the queue is fully finished (no more items to process).
 */
export function isQueueFinished(items: QueueItem[]): boolean {
  return items.every(
    (item) => item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled'
  );
}

/**
 * Find the next item to process.
 */
export function findNextItem(items: QueueItem[]): QueueItem | undefined {
  return items.find((item) => item.status === 'queued');
}

/**
 * Determine appropriate queue state from items.
 */
export function deriveQueueState(items: QueueItem[], currentState: QueueState): QueueState {
  if (items.length === 0) return 'idle';
  if (currentState === 'paused') return 'paused';
  if (items.some((i) => i.status === 'generating')) return 'running';
  if (isQueueFinished(items)) return 'completed';
  if (items.some((i) => i.status === 'queued')) return 'running';
  return currentState;
}
