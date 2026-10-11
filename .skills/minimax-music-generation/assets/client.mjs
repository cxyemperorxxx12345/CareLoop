import {collectMusic} from './music-stream.mjs';
export async function generateMusic({supabase,edgeUrl,params,signal,onProgress}) {
 const {data:{session}}=await supabase.auth.getSession();if(!session)throw Error('Login required');
 const response=await fetch(edgeUrl,{method:'POST',headers:{Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},body:JSON.stringify({action:'music',params}),signal});
 if(!response.ok)throw Error('Music request HTTP '+response.status);
 if(!response.headers.get('content-type')?.includes('text/event-stream'))throw Error('Expected event stream');
 const result=await collectMusic(response.body,onProgress);
 return {blob:new Blob(result.chunks,{type:'audio/mpeg'}),info:result.info};
}
// Call only after generateMusic resolves. Revoke returned URL on replacement/unmount.
export function showMusic(container,result){
 const url=URL.createObjectURL(result.blob);const player=document.createElement('audio');player.controls=true;player.src=url;
 const a=document.createElement('a');a.href=url;a.download='music.mp3';a.textContent='下载 MP3';container.replaceChildren(player,a);
 return ()=>{player.pause();player.removeAttribute('src');URL.revokeObjectURL(url);};
}
