// Shared wire contract; camelCase is only an internal function argument.
export function previewRequest(mediaId) {
  if (typeof mediaId !== 'string' || !mediaId.trim()) throw new Error('missing_media_id');
  return { action: 'preview_proxy', media_id: mediaId };
}
export function readPreviewRequest(body) {
  if (!body || body.action !== 'preview_proxy') throw new Error('invalid_preview_action');
  return previewRequest(body.media_id).media_id;
}
