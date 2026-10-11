// Dispatch before parsing: image display never requires Office parsing or OCR.
export function readerRoute(mediaType, { extract = false } = {}) {
  const route = contentRoute(mediaType);
  return {...route, extraction: extract ? route.extraction : null};
}
function contentRoute(mediaType) {
  switch (Number(mediaType)) {
    case 1: return {preview:"pdf", extraction:"pdf"};
    case 3: return {preview:"office-service", extraction:"docx"};
    case 4: return {preview:"office-service", extraction:"pptx"};
    case 5: return {preview:"office-service", extraction:"xlsx"};
    case 9: return {preview:"image", extraction:null};
    case 2: return {preview:"web-link", extraction:null};
    case 7: case 13: return {preview:"text", extraction:"text"};
    case 11: return {preview:"note", extraction:"note-api"};
    default: return {preview:"unsupported", extraction:null};
  }
}
