import {events,decodeHex} from './contract.mjs';
export async function collectMusic(body,onProgress=()=>{}) {
 let chunks=[],bytes=0,count=0,finished=false,info=null;
 const limit=64*1024*1024;
 for await(const event of events(body)){
  if(event==='[DONE]'){if(!finished)throw Error('DONE before music completion');continue;}
  const j=JSON.parse(event);if(j.base_resp?.status_code!==0)throw Error('Music business error: '+String(j.base_resp?.status_code));
  const d=j.data;if(!d||![1,2].includes(d.status))throw Error('Unknown music stream status');
  if(finished)throw Error('Data after final music event');
  const part=decodeHex(d.audio??'');
  if(d.status===1){bytes+=part.length;if(bytes>limit)throw Error('Audio exceeds memory budget');if(part.length)chunks.push(part);count++;onProgress({chunks:count,bytes});continue;}
  info=j.extra_info||{};
  // Terminal frames may carry a complete file or final delta. Size validates assembly.
  const size=info.audio_size ?? info.music_size;
  if(part.length && Number.isSafeInteger(size) && size===part.length){chunks=[part];bytes=part.length;}
  else if(!part.length || (Number.isSafeInteger(size)&&size===bytes+part.length)) {if(part.length)chunks.push(part);bytes+=part.length;}
  else throw Error('Ambiguous final audio payload; do not concatenate a possible full file twice');
  if(!bytes||bytes>limit)throw Error('Empty or oversized final audio');
  if(Number.isSafeInteger(size)&&size!==bytes)throw Error('Final audio size mismatch');
  finished=true;onProgress({chunks:count,bytes,complete:true});
 }
 if(!finished)throw Error('Stream closed without final music status');
 return {chunks,info};
}
