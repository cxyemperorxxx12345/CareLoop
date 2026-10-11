export function musicInput(p) {
 const allowed=['prompt','lyrics','is_instrumental','lyrics_optimizer'];
 for(const k of Object.keys(p))if(!allowed.includes(k))throw Error('Unexpected input: '+k);
 for(const k of ['is_instrumental','lyrics_optimizer'])if(p[k]!==undefined&&typeof p[k]!=='boolean')throw Error(k+' must be boolean');
 const prompt=p.prompt??'',lyrics=p.lyrics??'';
 if(typeof prompt!=='string'||[...prompt].length>2000||typeof lyrics!=='string'||[...lyrics].length>3500)throw Error('Invalid prompt/lyrics length');
 if(p.is_instrumental&&!prompt.trim())throw Error('Instrumental prompt required');
 if(!p.is_instrumental&&!lyrics.trim()&&!(p.lyrics_optimizer&&prompt.trim()))throw Error('Lyrics or automatic lyrics with prompt required');
 return {...p,model:'music-3.0',stream:true,output_format:'hex',audio_setting:{sample_rate:44100,bitrate:256000,format:'mp3'}};
}
export function lyricsInput(p) {
 for(const k of Object.keys(p))if(!['mode','prompt','lyrics','title'].includes(k))throw Error('Unexpected input: '+k);
 if(!['write_full_song','edit'].includes(p.mode))throw Error('Invalid lyrics mode');
 for(const [k,max] of [['prompt',2000],['lyrics',3500],['title',Infinity]])if(p[k]!==undefined&&(typeof p[k]!=='string'||[...p[k]].length>max))throw Error('Invalid '+k);
 if(p.mode!=='edit'&&p.lyrics)throw Error('Existing lyrics only valid for edit');
 return p;
}
// Byte-safe SSE: never parse individual transport chunks as JSON.
export async function* events(body) {
 const reader=body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',data=[];
 function line(s){if(s.endsWith('\r'))s=s.slice(0,-1);if(s===''){const value=data.join('\n');data=[];return value||null;}if(s.startsWith('data:'))data.push(s.slice(5).replace(/^ /,''));return null;}
 try{while(true){const r=await reader.read();buffer+=r.done?decoder.decode():decoder.decode(r.value,{stream:true});let i;
 while((i=buffer.indexOf('\n'))>=0){const v=line(buffer.slice(0,i));buffer=buffer.slice(i+1);if(v)yield v;}
 if(buffer.length>64*1024*1024)throw Error('SSE event exceeds memory budget');
 if(r.done){if(buffer.trim()||data.length)throw Error('Incomplete SSE frame');break;}}
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function decodeHex(s){if(typeof s!=='string'||s.length%2||!/^[0-9a-f]*$/i.test(s))throw Error('Invalid hex audio');return Uint8Array.from(s.match(/../g)||[],x=>parseInt(x,16));}
