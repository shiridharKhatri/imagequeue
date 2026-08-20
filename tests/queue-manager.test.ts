import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQueueItem, computeQueueStats, isQueueFinished, findNextItem } from '../src/queue/queue-types';
import type { QueueItem } from '../src/shared/types';

describe('Queue Types', () => {
  describe('createQueueItem', () => {
    it('should create item with correct defaults', () => {
      const item = createQueueItem('test prompt');
      expect(item.prompt).toBe('test prompt');
      expect(item.status).toBe('queued');
      expect(item.retryCount).toBe(0);
      expect(item.id).toBeTruthy();
      expect(item.createdAt).toBeGreaterThan(0);
    });

    it('should generate unique IDs', () => {
      const item1 = createQueueItem('prompt 1');
      const item2 = createQueueItem('prompt 2');
      expect(item1.id).not.toBe(item2.id);
    });
  });

  describe('computeQueueStats', () => {
    it('should compute stats correctly', () => {
      const items: QueueItem[] = [
        { ...createQueueItem('p1'), status: 'completed' },
        { ...createQueueItem('p2'), status: 'generating' },
        { ...createQueueItem('p3'), status: 'queued' },
        { ...createQueueItem('p4'), status: 'failed' },
      ];

      const stats = computeQueueStats(items);
      expect(stats.total).toBe(4);
      expect(stats.completed).toBe(1);
      expect(stats.generating).toBe(1);
      expect(stats.queued).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.progressPercent).toBe(50); // 2 of 4 finished (completed + failed)
    });

    it('should handle empty array', () => {
      const stats = computeQueueStats([]);
      expect(stats.total).toBe(0);
      expect(stats.progressPercent).toBe(0);
    });

    it('should compute 100% when all completed', () => {
      const items: QueueItem[] = [
        { ...createQueueItem('p1'), status: 'completed' },
        { ...createQueueItem('p2'), status: 'completed' },
      ];
      const stats = computeQueueStats(items);
      expect(stats.progressPercent).toBe(100);
    });
  });

  describe('isQueueFinished', () => {
    it('should return true when all items are terminal', () => {
      const items: QueueItem[] = [
        { ...createQueueItem('p1'), status: 'completed' },
        { ...createQueueItem('p2'), status: 'failed' },
        { ...createQueueItem('p3'), status: 'cancelled' },
      ];
      expect(isQueueFinished(items)).toBe(true);
    });

    it('should return false when items are still queued', () => {
      const items: QueueItem[] = [
        { ...createQueueItem('p1'), status: 'completed' },
        { ...createQueueItem('p2'), status: 'queued' },
      ];
      expect(isQueueFinished(items)).toBe(false);
    });

    it('should return false when items are generating', () => {
      const items: QueueItem[] = [
        { ...createQueueItem('p1'), status: 'generating' },
      ];
      expect(isQueueFinished(items)).toBe(false);
    });
  });

  describe('findNextItem', () => {
    it('should find first queued item', () => {
      const items: QueueItem[] = [
        { ...createQueueItem('p1'), status: 'completed' },
        { ...createQueueItem('p2'), status: 'queued' },
        { ...createQueueItem('p3'), status: 'queued' },
      ];
      const next = findNextItem(items);
      expect(next?.prompt).toBe('p2');
    });

    it('should return undefined when no queued items', () => {
      const items: QueueItem[] = [
        { ...createQueueItem('p1'), status: 'completed' },
        { ...createQueueItem('p2'), status: 'failed' },
      ];
      expect(findNextItem(items)).toBeUndefined();
    });
  });
});
