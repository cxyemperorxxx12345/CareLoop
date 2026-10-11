import { createClient } from 'npm:@supabase/supabase-js@2';
import { gatewayRequest } from './gateway.mjs';
import { musicInput, lyricsInput } from './contract.mjs';
const required=(k:string)=>{const v=Deno.env.get(k);if(!v)throw Error('Missing server configuration: '+k);return v;};
Deno.serve(async(req:Request)=>{
 const origin=Deno.env.get('APP_ORIGIN')||'';
 const headers={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
 const fail=(error:string,status=400)=>Response.json({error},{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return fail('Method not allowed',405);
 let stage='configuration';
 try{
 const userClient=createClient(required('SUPABASE_URL'),required('SUPABASE_ANON_KEY'),{global:{headers:{Authorization:req.headers.get('Authorization')||''}}});
 stage='authentication';
 const {data,error}=await userClient.auth.getUser();if(error||!data.user)return fail('Login required',401);
 stage='input';
 const {action,params}=await req.json();if(!['music','lyrics'].includes(action))return fail('Invalid action');
 const body=action==='music'?musicInput(params):lyricsInput(params);
 stage='configuration';
 const key=required('INTEGRATIONS_API_KEY');
 stage='transport';
 const controller=new AbortController();
 const cancel=()=>controller.abort();
 req.signal.addEventListener('abort',cancel,{once:true});
 if(req.signal.aborted)cancel();
 const timer=setTimeout(cancel,600000);
 const cleanup=()=>{clearTimeout(timer);req.signal.removeEventListener('abort',cancel);};
 let response:Response;
 try {
 response=await fetch(...gatewayRequest(action,key,body,controller.signal));
 } catch(e) {cleanup();throw e;}
 // Keep deadline active until the response body completes, not just headers.
 if(response.body){
 const reader=response.body.getReader();
 const stream=new ReadableStream({
 async pull(c){try{const r=await reader.read();if(r.done){cleanup();reader.releaseLock();c.close();}else c.enqueue(r.value);}catch(e){cleanup();c.error(e);}},
 async cancel(reason){cleanup();controller.abort();await reader.cancel(reason);}
 });
 response=new Response(stream,{status:response.status,headers:response.headers});
 }else cleanup();
 stage='response';

 if(!response.ok){await response.body?.cancel();return fail('Gateway HTTP '+response.status,response.status);}
 if(action==='lyrics'){
 const j=await response.json();if(j.base_resp?.status_code!==0)return fail('Lyrics business error: '+String(j.base_resp?.status_code));
 if(typeof j.lyrics!=='string'||!j.lyrics.trim())return fail('Empty lyrics result');
 return Response.json(j,{headers});
 }
 if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream')){await response.body?.cancel();return fail('Expected audio event stream',502);}
 // Forward without buffering; browser parses business errors and completion events.
 return new Response(response.body,{headers:{...headers,'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'}});
 }catch(e){
 const requestId=crypto.randomUUID();
 const kind=e instanceof Error?e.name:'Error';
 // Never log headers, credentials, lyrics, or arbitrary upstream error text.
 console.error(JSON.stringify({requestId,stage,kind}));
 const message=stage==='configuration'?'Server configuration missing or invalid':
 stage==='input'?'Invalid input: check action, field types and prompt/lyrics limits':
 stage==='authentication'?'Session verification failed':
 stage==='transport'?'Gateway connection failed, timed out, or was cancelled':
 'Gateway response parsing failed';
 return Response.json({error:message,stage,request_id:requestId,retry_generation:false},{status:stage==='input'?400:stage==='configuration'?500:502,headers});
 }
});
