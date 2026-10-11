import assert from 'node:assert/strict';
import {previewBytes,pdfBytes} from './preview-bytes.mjs';
import {readPreviewResponse} from './preview-response.mjs';
import {readerRoute} from './reader-route.mjs';
const source=new TextEncoder().encode('%PDF-1.7\nfixture');
for(const input of [source.buffer,new Blob([source]),source]) assert.deepEqual(new Uint8Array(await previewBytes(input)),source);
const padded=new Uint8Array(source.length+4);padded.set(source,2);
assert.deepEqual(new Uint8Array(await previewBytes(padded.subarray(2,-2))),source);
for(const input of ['',{},new ArrayBuffer(0),new Blob([])]) await assert.rejects(()=>previewBytes(input));
const copy=await pdfBytes(source.buffer);copy[0]=0;assert.equal(source[0],37);
await assert.rejects(()=>pdfBytes(new TextEncoder().encode('not pdf')));
for(const type of ['application/pdf','image/png','application/octet-stream']) {
 const result=await readPreviewResponse(new Response(source,{headers:{'content-type':type}}));assert.equal(result.contentType,type);assert.deepEqual(new Uint8Array(result.bytes),source);
}
await assert.rejects(()=>readPreviewResponse(new Response('{}',{headers:{'content-type':'application/json'}})));
await assert.rejects(()=>readPreviewResponse(new Response('error',{status:403})));
await assert.rejects(()=>readPreviewResponse(new Response(null)));
for(const [id,kind] of [[1,'pdf'],[9,'image'],[3,'office-service'],[4,'office-service'],[5,'office-service'],[2,'web-link'],[7,'text'],[13,'text'],[11,'note']]) {
 const route=readerRoute(id);assert.equal(route.preview,kind);assert.equal(route.extraction,null);
}
console.log('PASS binary normalization, offset, empty/error rejection, PDF copy, raw response MIME, preview-only routes. Office rendering and browser NOT tested.');

// Exercise the request entry point with format-specific bytes and MIME.
const {fetchPreviewBlob} = await import('./preview-response.mjs');
for (const [mime, bytes] of [
 ['image/png', new Uint8Array([137,80,78,71,13,10,26,10,255,0,128])],
 ['text/plain; charset=utf-8', new TextEncoder().encode('中文 TXT\nsecond line')],
 ['text/html; charset=utf-8', new TextEncoder().encode('<!doctype html><p>网页</p>')],
 ['application/pdf', source],
]) {
 const controller = new AbortController();
 const blob = await fetchPreviewBlob({endpoint:'/functions/v1/ima-reader',mediaId:'test-id',
  headers:{Authorization:'Bearer test-session'}, signal:controller.signal,
  fetchImpl:async (url, options)=> {
   assert.equal(url,'/functions/v1/ima-reader');
   assert.deepEqual(JSON.parse(options.body),{action:'preview_proxy',media_id:'test-id'});
   assert.equal(options.headers.get('Authorization'),'Bearer test-session');
   assert.equal(options.signal,controller.signal);
   return new Response(bytes,{headers:{'Content-Type':mime}});
  }});
 assert.equal(blob.type,mime);
 assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
}
for (const response of [new Response('denied',{status:403}),new Response('{}',{headers:{'content-type':'application/problem+json'}}),new Response(null)]) {
 await assert.rejects(()=>fetchPreviewBlob({endpoint:'/proxy',mediaId:'test-id',fetchImpl:async()=>response}));
}
await assert.rejects(()=>fetchPreviewBlob({endpoint:'/proxy',mediaId:'test-id',fetchImpl:async()=>{throw new DOMException('Aborted','AbortError')}}),{name:'AbortError'});
console.log('PASS native fetch entry: PNG/TXT/HTML/PDF exact bytes, MIME, request contract, HTTP/JSON/empty rejection and abort propagation (offline).');

// Test both sides of the same wire contract, not a frontend-only mock.
const {readPreviewRequest} = await import('./preview-request.mjs');
for (const [mime,bytes] of [['application/pdf',source],['image/png',new Uint8Array([137,80,78,71,13,10,26,10])]]) {
 const blob=await fetchPreviewBlob({endpoint:'/proxy',mediaId:'fixture-id',fetchImpl:async(_,options)=>{
   const mediaId=readPreviewRequest(JSON.parse(options.body));
   assert.equal(mediaId,'fixture-id');
   return new Response(bytes,{headers:{'Content-Type':mime}});
 }});
 assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
 assert.equal(blob.type,mime);
}
for (const body of [{action:'preview_proxy',mediaId:'wrong-field'},{action:'preview_proxy',media_id:''},{action:'preview_proxy',media_id:3},null]) assert.throws(()=>readPreviewRequest(body));
let called=false;
await assert.rejects(()=>fetchPreviewBlob({endpoint:'/proxy',mediaId:'',fetchImpl:async()=>{called=true;}}));
assert.equal(called,false);
console.log('PASS paired PDF/PNG wire contract: media_id roundtrip, camelCase/empty/type rejection; offline only.');
