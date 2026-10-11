import assert from 'node:assert/strict';
import {authenticatedPreview} from './authenticated-preview.mjs';
let token='user-session-A',calls=0;
const supabase={auth:{getSession:async()=>({data:{session:token?{access_token:token}:null},error:null})}};
const opts={supabase,anonKey:'public-key',endpoint:'https://app.example/preview',mediaId:'file-1',fetchImpl:async(url,init)=>{
 calls++;assert.equal(init.headers.get('Authorization'),`Bearer ${token}`);
 assert.equal(init.headers.get('apikey'),'public-key');
 assert.equal(JSON.parse(init.body).media_id,'file-1');
 assert.equal(init.headers.has('endpoint'),false);
 return new Response(new Uint8Array([80,75,3,4]),{headers:{'content-type':'application/octet-stream'}});
}};
assert.equal((await authenticatedPreview(opts)).size,4);
token='user-session-B';assert.equal((await authenticatedPreview(opts)).size,4);
token=null;await assert.rejects(()=>authenticatedPreview(opts),/LOGIN_REQUIRED/);
token='public-key';await assert.rejects(()=>authenticatedPreview(opts),/LOGIN_REQUIRED/);
assert.equal(calls,2);
token='valid';await assert.rejects(()=>authenticatedPreview({...opts,fetchImpl:async()=>new Response('{"error":"unauthorized"}',{status:401})}),/401/);
console.log('PASS: session token, refreshed session, original Blob, media_id, missing/anon session blocked before fetch, HTTP 401 retained');
