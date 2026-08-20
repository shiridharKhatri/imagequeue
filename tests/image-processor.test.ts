import { describe, it, expect } from 'vitest';
import { generateFilenames } from '../src/processing/image-processor';

describe('Image Processor', () => {
  describe('generateFilenames', () => {
    it('should generate correct filenames with prefix', () => {
      const filenames = generateFilenames(4, 'article-name', 'webp');
      expect(filenames).toEqual([
        'article-name-01.webp',
        'article-name-02.webp',
        'article-name-03.webp',
        'article-name-04.webp',
      ]);
    });

    it('should pad numbers correctly', () => {
      const filenames = generateFilenames(12, 'test', 'png');
      expect(filenames[0]).toBe('test-01.png');
      expect(filenames[9]).toBe('test-10.png');
      expect(filenames[11]).toBe('test-12.png');
    });

    it('should use correct extensions', () => {
      expect(generateFilenames(1, 'img', 'png')[0]).toBe('img-01.png');
      expect(generateFilenames(1, 'img', 'jpg')[0]).toBe('img-01.jpg');
      expect(generateFilenames(1, 'img', 'webp')[0]).toBe('img-01.webp');
    });

    it('should handle single image', () => {
      const filenames = generateFilenames(1, 'single', 'webp');
      expect(filenames).toEqual(['single-01.webp']);
    });
  });
});
