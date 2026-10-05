/**
 * Google Drive Upload Integration Module
 * File: src/api/gdrive-uploader.ts
 */

export interface GoogleDriveUploadResponse {
  success: boolean;
  fileId: string;
  name: string;
}

/**
 * Refresh Google Access Token using Client Credentials & Refresh Token
 */
export async function refreshGoogleAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Google token (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Access token not found in refresh response');
  }

  return data.access_token;
}

/**
 * Fetch authenticated user's email address
 */
export async function getUserEmail(accessToken: string): Promise<string> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to retrieve user email: ${response.statusText}`);
  }

  const data = await response.json();
  return data.email || 'unknown-user';
}

/**
 * Upload a file to Google Drive using multipart/related upload.
 */
export async function uploadZipToGoogleDrive(
  accessToken: string,
  folderId: string | undefined,
  filename: string,
  zipBlob: Blob
): Promise<GoogleDriveUploadResponse> {
  const boundary = 'gdrive_upload_multipart_boundary';
  
  // Clean up folder ID (empty string is treated as undefined)
  const parents = folderId && folderId.trim() !== '' ? [folderId.trim()] : undefined;

  const metadata = {
    name: filename,
    mimeType: 'application/zip',
    parents: parents,
  };

  const metadataPart = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    '\r\n'
  ].join('');

  const filePartHeader = [
    `--${boundary}\r\n`,
    'Content-Type: application/zip\r\n\r\n'
  ].join('');

  const filePartFooter = `\r\n--${boundary}--\r\n`;

  // Construct multipart/related body using Blobs to keep memory footprint low
  const body = new Blob([
    new Blob([metadataPart], { type: 'text/plain' }),
    new Blob([filePartHeader], { type: 'text/plain' }),
    zipBlob,
    new Blob([filePartFooter], { type: 'text/plain' })
  ], { type: `multipart/related; boundary=${boundary}` });

  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    let message = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      message = errorJson.error?.message || errorJson.message || message;
    } catch {
      // ignore
    }
    throw new Error(`Google Drive upload failed (${response.status}): ${message}`);
  }

  const result = await response.json();
  return {
    success: true,
    fileId: result.id,
    name: result.name || filename,
  };
}
