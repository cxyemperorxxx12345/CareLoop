import assert from 'node:assert/strict';
import {createImaClient} from './ima-client.mjs';
const calls=[];let bad=false;
const client=createImaClient({clientId:'test-id',apiKey:'test-key',fetchImpl:async(url,opts)=>{
 calls.push({url,...opts});
 if(url==='https://files.example.test/file') {assert.deepEqual(opts.headers,{'x-file':'test'});return new Response('%PDF-test',{headers:{'content-type':'application/pdf'}});}
 assert.equal(opts.method,'POST');assert.equal(opts.headers['ima-openapi-clientid'],'test-id');assert.equal(opts.headers['ima-openapi-apikey'],'test-key');
 const path=new URL(url).pathname;const b=JSON.parse(opts.body);
 if(path.endsWith('search_knowledge_base')){assert.deepEqual(b,{query:'',cursor:'',limit:20});return Response.json({code:0,data:bad?{list:[]}:{info_list:[],is_end:true}});}
 if(path.endsWith('get_knowledge_list')){assert.equal(b.knowledge_base_id,'kb');assert.equal(b.kb_id,undefined);return Response.json({code:0,data:{knowledge_list:[],is_end:true}});}
 if(path.endsWith('get_media_info')){assert.equal(b.media_id,'m');return Response.json({code:0,data:{media_type:11,notebook_ext_info:{notebook_id:'n'},url_info:{url:'https://files.example.test/file',headers:{'x-file':'test'}}}});}
 if(path.endsWith('get_doc_content')){assert.deepEqual(b,{note_id:'n',target_content_format:0});return Response.json({code:0,data:{content:'text'}});}
 throw Error('unexpected path '+path);
}});
await client.listKb();await client.listFiles({kbId:'kb'});assert.deepEqual(await client.metadata('m'),{mediaType:11,notebookId:'n'});await client.note('n');assert.equal((await client.download('m')).contentType,'application/pdf');bad=true;await assert.rejects(()=>client.listKb(),/MISSING_info_list/);
assert(calls.filter(c=>c.url.includes('ima.qq.com')).every(c=>new URL(c.url).pathname.startsWith('/openapi/')));
console.log('PASS request paths, auth headers, payloads, response fields, missing-field rejection, note mapping, file headers. Mock transport only.');
