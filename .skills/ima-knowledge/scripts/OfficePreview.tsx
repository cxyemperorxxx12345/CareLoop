import {useEffect,useState} from 'react';
import {BrowserOfficeView} from './BrowserOfficeView';
import {authenticatedPreview} from './authenticated-preview.mjs';
import type {SupabaseClient} from '@supabase/supabase-js';

export function OfficePreview({supabase,anonKey,endpoint,mediaId,filename}: {
 supabase:SupabaseClient;anonKey:string;endpoint:string;mediaId:string;filename:string;
}) {
 const [result,setResult]=useState<{id:string;blob?:Blob;error?:string}>({id:''});
 const [attempt,setAttempt]=useState(0);
 useEffect(()=>{
  const abort=new AbortController();
  setResult({id:mediaId});
  authenticatedPreview({supabase,anonKey,endpoint,mediaId,signal:abort.signal})
   .then((blob:Blob)=>{if(!abort.signal.aborted)setResult({id:mediaId,blob});})
   .catch((e:unknown)=>{if(!abort.signal.aborted)setResult({id:mediaId,error:e instanceof Error?e.message:String(e)});});
  return ()=>abort.abort();
 },[supabase,anonKey,endpoint,mediaId,attempt]);
 if(result.id!==mediaId)return <p role="status">正在加载文档…</p>;
 if(result.error)return <div role="alert">{result.error==='LOGIN_REQUIRED'?'请登录后预览文件':result.error}<button onClick={()=>setAttempt(x=>x+1)}>重试</button></div>;
 if(!result.blob)return <p role="status">正在加载文档…</p>;
 return <BrowserOfficeView blob={result.blob} filename={filename}/>;
}
