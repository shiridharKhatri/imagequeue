/**
 * WordPress Media Library Upload Module
 * File: src/api/wp-uploader.ts
 */

export interface WPUploadMetadata {
  title?: string;
  alt_text?: string;
  caption?: string;
  description?: string;
  filename?: string;
  author?: string;
  author_name?: string;
  country?: string;
  state?: string;
  city?: string;
  sub_location?: string;
  latitude?: string;
  longitude?: string;
}

export interface WPUploadConfig {
  siteUrl: string; // e.g. "https://your-site.com"
  apiKey: string;  // e.g. "aimedia_..."
}

export interface WPUploadResponse {
  success: boolean;
  attachment_id: number;
  url: string;
  title: string;
  alt_text: string;
  caption: string;
  description: string;
  file_path: string;
  sizes: Record<string, string>;
}

/**
 * Uploads an image (base64 or remote URL) along with metadata directly to the site media folder.
 */
export async function uploadToWordPressMedia(
  config: WPUploadConfig,
  imageDataOrUrl: string,
  metadata: WPUploadMetadata = {}
): Promise<WPUploadResponse> {
  const cleanSiteUrl = config.siteUrl.replace(/\/+$/, '');
  const endpoint = `${cleanSiteUrl}/wp-json/ai-media/v1/upload`;
  
  const payload = {
    image: imageDataOrUrl,
    title: metadata.title || '',
    alt_text: metadata.alt_text || '',
    caption: metadata.caption || '',
    description: metadata.description || '',
    filename: metadata.filename || '',
    author: metadata.author || '',
    author_name: metadata.author_name || '',
    country: metadata.country || '',
    state: metadata.state || '',
    city: metadata.city || '',
    sub_location: metadata.sub_location || '',
    latitude: metadata.latitude || '',
    longitude: metadata.longitude || ''
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AI-Upload-Key': config.apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(`WordPress Media Upload Failed (${response.status}): ${errorJson.message || response.statusText}`);
  }

  const result: WPUploadResponse = await response.json();
  return result;
}

/**
 * Utility: Converts HTML Image element or Blob to Base64 string
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
