import {fetchPreviewBlob} from './preview-response.mjs';
// Internal route name remains office-service for compatibility; it does not
// mean a converter exists. DOCX/PPTX now render in the browser from original bytes.
export async function loadSupplementalPreview({kind,endpoint,mediaId,headers,signal,fetchImpl=fetch}) {
 if(kind==='office-service'||kind==='web-link')return {kind,blob:await fetchPreviewBlob({endpoint,mediaId,headers,signal,fetchImpl})};
 return null; // Keep the existing PDF/image/text/note implementations.
}
