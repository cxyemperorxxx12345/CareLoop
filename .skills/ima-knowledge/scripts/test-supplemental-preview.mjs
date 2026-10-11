import assert from 'node:assert/strict';
import {loadSupplementalPreview} from './supplemental-preview.mjs';
const actions=[];
const common={endpoint:'https://app.example/api',mediaId:'id',headers:{Authorization:'Bearer session'},fetchImpl:async(_url,options)=>{
 actions.push(JSON.parse(options.body).action);
 assert.equal(options.headers.get('authorization'),'Bearer session');
 return new Response('PK-test-bytes',{headers:{'Content-Type':'application/octet-stream'}});
}};
for(const kind of ['office-service','web-link'])assert.equal(await(await loadSupplementalPreview({...common,kind})).blob.text(),'PK-test-bytes');
assert.deepEqual(actions,['preview_proxy','preview_proxy']);
for(const kind of ['pdf','image','text','note','unsupported'])assert.equal(await loadSupplementalPreview({...common,kind}),null);
assert.equal(actions.length,2);
await assert.rejects(()=>loadSupplementalPreview({...common,kind:'office-service',fetchImpl:async()=>new Response('bad',{status:502})}),/502/);
console.log('PASS original bytes, existing auth, preview_proxy only, unchanged non-Office routes, HTTP errors');
