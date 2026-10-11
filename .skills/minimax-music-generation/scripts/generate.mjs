#!/usr/bin/env node
import {readFile,writeFile,access} from 'node:fs/promises';
import {musicInput,lyricsInput} from '../assets/contract.mjs';
import {gatewayRequest} from '../assets/gateway.mjs';
import {collectMusic} from '../assets/music-stream.mjs';
const [action,input,output]=process.argv.slice(2);
if(action==='--help'){console.log('node scripts/generate.mjs music|lyrics input.json output.mp3|output.json\nServer environment: INTEGRATIONS_API_KEY. No automatic retry.');process.exit(0);}
try{
 if(!['music','lyrics'].includes(action)||!input||!output)throw Error('See --help');
 try{await access(output);throw Error('Output exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!process.env.INTEGRATIONS_API_KEY)throw Error('INTEGRATIONS_API_KEY required');
 const raw=JSON.parse(await readFile(input,'utf8'));const body=action==='music'?musicInput(raw):lyricsInput(raw);
 const r=await fetch(...gatewayRequest(action,process.env.INTEGRATIONS_API_KEY,body,AbortSignal.timeout(600000)));
 if(!r.ok)throw Error('Upstream HTTP '+r.status);
 if(action==='music'){
 if(!r.headers.get('content-type')?.includes('text/event-stream'))throw Error('Expected SSE');
 const result=await collectMusic(r.body,p=>console.error(JSON.stringify(p)));await writeFile(output,Buffer.concat(result.chunks),{flag:'wx',mode:0o600});console.log(JSON.stringify({output,info:result.info}));
 }else{const j=await r.json();if(j.base_resp?.status_code!==0||!j.lyrics?.trim())throw Error('Lyrics generation failed');await writeFile(output,JSON.stringify(j,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({output}));}
}catch(e){console.error(JSON.stringify({error:e.message,retry_generation:false}));process.exitCode=1;}
