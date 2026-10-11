import { previewRequest } from './preview-request.mjs';
import { previewBytes } from './preview-bytes.mjs';
// Caller supplies a same-application authenticated response, never provider secrets.
export async function readPreviewResponse(response) {
  const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    throw new Error('Download returned JSON instead of a file');
  }
  const bytes = await previewBytes(await response.arrayBuffer());
  return { bytes, contentType };
}

// Native fetch only: never pass SDK-decoded data to this function.
// endpoint is the application's authenticated proxy; only media_id crosses the boundary.
export async function fetchPreviewBlob({ endpoint, mediaId, headers, signal, fetchImpl = fetch }) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Content-Type', 'application/json');
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers: requestHeaders,
    body: JSON.stringify(previewRequest(mediaId)),
    signal,
  });
  const mime = response.headers.get('content-type') || 'application/octet-stream';
  const { bytes } = await readPreviewResponse(response);
  return new Blob([bytes], { type: mime });
}
