// Browser only. Inject DOMPurify (tested 3.4.15); mount returned HTML ONLY in a sandboxed iframe.
export async function readWebBlob(blob) {
  if (!(blob instanceof Blob) || !blob.size || blob.size>5*1024*1024) throw new Error('WEB_INVALID_SIZE');
  const mime=blob.type.split(';')[0].toLowerCase();
  if(!['text/html','application/xhtml+xml','application/octet-stream',''].includes(mime)) throw new Error('WEB_EXPECTED_HTML');
  const html=await blob.text();
  if(!/<(?:!doctype\s+html|html|head|body|h[1-6]|p|div|section|article|table)(?:\s|>)/i.test(html)) throw new Error('WEB_EXPECTED_HTML');
  return html;
}
export function webSnapshot(html,{purify,baseUrl,allowedResourceOrigins=[]}={}) {
  if(!purify?.sanitize) throw new Error('WEB_SANITIZER_REQUIRED');
  const origins=allowedResourceOrigins.map(x=>{const u=new URL(x);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.origin!==x) throw new Error('WEB_INVALID_RESOURCE_ORIGIN');return u.origin;});
  let base;
  if(baseUrl){base=new URL(baseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password) throw new Error('WEB_INVALID_BASE_URL');}
  const clean=purify.sanitize(html,{WHOLE_DOCUMENT:true,USE_PROFILES:{html:true},
    FORBID_TAGS:['script','iframe','frame','object','embed','form','input','button','textarea','select','video','audio','source','base','meta','link'],
    FORBID_ATTR:['srcdoc','srcset','ping','action','formaction']});
  const doc=new DOMParser().parseFromString(clean,'text/html');
  for(const image of doc.querySelectorAll('img')) {
    const raw=image.getAttribute('src')||'';
    if(/^data:image\/(png|jpeg|gif|webp);base64,/i.test(raw)) continue;
    try {const u=new URL(raw,base);if(!origins.includes(u.origin)||u.username||u.password) throw Error();image.setAttribute('src',u.href);image.setAttribute('referrerpolicy','no-referrer');}
    catch {image.removeAttribute('src');image.setAttribute('alt',image.getAttribute('alt')||'外部图片未加载');}
  }
  for(const a of doc.querySelectorAll('a[href]')) {
    try {const u=new URL(a.getAttribute('href'),base);if(!['https:','http:'].includes(u.protocol)||u.username||u.password) throw Error();a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';}
    catch {a.removeAttribute('href');}
  }
  const meta=doc.createElement('meta');meta.httpEquiv='Content-Security-Policy';
  meta.content=`default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: ${origins.join(' ')}; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'`;
  doc.head.prepend(meta);
  return '<!doctype html>'+doc.documentElement.outerHTML;
}
