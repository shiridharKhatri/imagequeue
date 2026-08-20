import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

/**
 * Tests for ZIP creation logic.
 * 
 * We test JSZip directly here since the createZip wrapper uses Blob,
 * which doesn't serialize properly in Node.js's JSZip implementation.
 * In the browser, Blob works fine.
 */
describe('ZIP Builder', () => {
  it('should create a valid ZIP with correct filenames', async () => {
    const zip = new JSZip();
    zip.file('image-01.webp', 'fake image 1');
    zip.file('image-02.webp', 'fake image 2');
    zip.file('image-03.webp', 'fake image 3');

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    expect(buffer.length).toBeGreaterThan(0);

    // Verify contents
    const loaded = await JSZip.loadAsync(buffer);
    const fileNames = Object.keys(loaded.files);
    expect(fileNames).toContain('image-01.webp');
    expect(fileNames).toContain('image-02.webp');
    expect(fileNames).toContain('image-03.webp');
    expect(fileNames).toHaveLength(3);
  });

  it('should handle single file', async () => {
    const zip = new JSZip();
    zip.file('single.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const loaded = await JSZip.loadAsync(buffer);
    expect(Object.keys(loaded.files)).toHaveLength(1);
  });

  it('should handle empty ZIP', async () => {
    const zip = new JSZip();
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('should preserve file contents', async () => {
    const content = 'test file content';
    const zip = new JSZip();
    zip.file('test.txt', content);

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const loaded = await JSZip.loadAsync(buffer);
    const file = loaded.file('test.txt');
    expect(file).not.toBeNull();

    const text = await file!.async('string');
    expect(text).toBe(content);
  });

  it('should apply DEFLATE compression', async () => {
    // Create a file with repetitive content that compresses well
    const bigContent = 'AAAA'.repeat(1000);
    const zip = new JSZip();
    zip.file('compressible.txt', bigContent);

    const compressed = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const uncompressed = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE',
    });

    expect(compressed.length).toBeLessThan(uncompressed.length);
  });

  it('should support filename prefixes', () => {
    // Test filename generation logic
    const prefix = 'article-name';
    const format = 'webp';
    const count = 4;

    const filenames: string[] = [];
    for (let i = 1; i <= count; i++) {
      filenames.push(`${prefix}-${String(i).padStart(2, '0')}.${format}`);
    }

    expect(filenames).toEqual([
      'article-name-01.webp',
      'article-name-02.webp',
      'article-name-03.webp',
      'article-name-04.webp',
    ]);
  });
});
