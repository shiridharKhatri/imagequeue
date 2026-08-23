/**
 * WordPress Media Library Upload Module
 * File: src/api/wp-uploader.ts
 */

export interface WPUploadPayload {
  image: string; // Base64 data URL (e.g. data:image/webp;base64,...)
  title: string; // Cleaned title
  alt_text?: string; // Alt text
  caption?: string; // Caption
  description?: string; // Description
  filename: string; // Filename e.g. "my-image.webp"
  author?: string; // Author display name or username
  author_name?: string; // Alternative author param
  make?: string; // Camera Make e.g. "Fujifilm" or "Apple"
  model?: string; // Camera Model e.g. "X-H2S" or "iPhone 15 Pro"
  lensModel?: string; // Lens e.g. "XF50-140mm"
  lens_model?: string; // Lens alias
  software?: string; // Software e.g. "iOS 17.5"
  dateTimeOriginal?: string; // Date original e.g. "2026:08:20 13:01:44"
  date_time_original?: string; // Date original alias
  country?: string; // Country e.g. "United States"
  state?: string; // State e.g. "California"
  city?: string; // City e.g. "Los Angeles"
  sub_location?: string; // Neighborhood / Sub-location e.g. "Downtown"
  subLocation?: string; // Sub-location alias
  latitude?: string; // Decimal Latitude e.g. "34.0522"
  gpsLatitude?: string; // Latitude alias
  longitude?: string; // Decimal Longitude e.g. "-118.2437"
  gpsLongitude?: string; // Longitude alias
}

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
  make?: string;
  model?: string;
  lens_model?: string;
  software?: string;
  date_time_original?: string;
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
  alt_text?: string;
  author_id?: number;
  author_name?: string;
  file_path?: string;
  mime_type?: string;
  caption?: string;
  description?: string;
  sizes?: Record<string, string>;
}

/**
 * Uploads an image payload directly to WordPress.
 */
export async function uploadToWordPress(
  siteUrl: string,
  apiKey: string,
  payload: WPUploadPayload
): Promise<WPUploadResponse> {
  let cleanSiteUrl = siteUrl.replace(/\/+$/, '');
  
  if (cleanSiteUrl.includes('/wp-json/')) {
    const wpJsonIndex = cleanSiteUrl.indexOf('/wp-json/');
    cleanSiteUrl = cleanSiteUrl.substring(0, wpJsonIndex);
  }

  const endpoint = `${cleanSiteUrl}/wp-json/ai-media/v1/upload`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AI-Upload-Key': apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let errorMessage = response.statusText;
    try {
      const errorText = await response.text();
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.message || errorJson.error || errorMessage;
      } catch {
        if (errorText.includes('<title>')) {
          const match = errorText.match(/<title>([^<]+)<\/title>/i);
          errorMessage = match ? match[1] : errorText.substring(0, 200);
        } else {
          errorMessage = errorText.substring(0, 200);
        }
      }
    } catch {
      // ignore
    }
    throw new Error(`Upload failed (${response.status}): ${errorMessage || 'Unknown Error'}`);
  }

  const result: WPUploadResponse = await response.json();
  return result;
}

/**
 * Uploads an image (base64 or remote URL) along with metadata directly to the site media folder.
 * @deprecated Use uploadToWordPress instead.
 */
export async function uploadToWordPressMedia(
  config: WPUploadConfig,
  imageDataOrUrl: string,
  metadata: WPUploadMetadata = {}
): Promise<WPUploadResponse> {
  const payload: WPUploadPayload = {
    image: imageDataOrUrl,
    title: metadata.title || '',
    alt_text: metadata.alt_text || '',
    caption: metadata.caption || '',
    description: metadata.description || '',
    filename: metadata.filename || 'image.webp',
    author: metadata.author || '',
    author_name: metadata.author_name || '',
    country: metadata.country || '',
    state: metadata.state || '',
    city: metadata.city || '',
    sub_location: metadata.sub_location || '',
    latitude: metadata.latitude || '',
    longitude: metadata.longitude || '',
    make: metadata.make || '',
    model: metadata.model || '',
    lensModel: metadata.lens_model || '',
    software: metadata.software || '',
    dateTimeOriginal: metadata.date_time_original || ''
  };

  return uploadToWordPress(config.siteUrl, config.apiKey, payload);
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
