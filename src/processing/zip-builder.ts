import JSZip from 'jszip';

/**
 * ZIP file builder using JSZip.
 *
 * Creates ZIP archives from a collection of named blobs.
 * All processing happens locally in the browser.
 */

export interface ZipEntry {
  filename: string;
  blob: Blob;
}

/**
 * Create a ZIP archive from a list of entries.
 *
 * @param entries - Files to include in the ZIP
 * @param compressionLevel - DEFLATE compression level (1-9, default 6)
 * @returns ZIP file as a Blob
 */
export async function createZip(
  entries: ZipEntry[],
  compressionLevel: number = 6
): Promise<Blob> {
  const zip = new JSZip();

  for (const entry of entries) {
    zip.file(entry.filename, entry.blob);
  }

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: compressionLevel },
  });
}

/**
 * Create a ZIP and return a downloadable object URL.
 *
 * Remember to call URL.revokeObjectURL after the download is complete.
 */
export async function createZipUrl(
  entries: ZipEntry[],
  compressionLevel: number = 6
): Promise<string> {
  const blob = await createZip(entries, compressionLevel);
  return URL.createObjectURL(blob);
}
