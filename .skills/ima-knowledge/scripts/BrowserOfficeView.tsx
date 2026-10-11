import {useEffect, useRef, useState} from 'react';

// Copy assets/office-browser to public/ima-office in the generated Vite app.
// blob is fetched once via the existing authenticated fetchPreviewBlob.
export function BrowserOfficeView({blob, filename}: {blob: Blob; filename: string}) {
 const host=useRef<HTMLDivElement>(null);
 const [state,setState]=useState({loading:true,error:'',warnings:[] as string[]});
 const [attempt,setAttempt]=useState(0);
 useEffect(()=>{
  const abort=new AbortController();let dispose:(()=>void)|undefined;
  setState({loading:true,error:'',warnings:[]});
  (async()=>{
   try {
    const moduleUrl='/ima-office/render.mjs';
    const {renderBrowserOffice}=await import(/* @vite-ignore */ moduleUrl);
    const data=await blob.arrayBuffer();
    if(abort.signal.aborted)return;
    const result=await renderBrowserOffice({data,filename,container:host.current!,signal:abort.signal});
    dispose=result.dispose;
    if(abort.signal.aborted){dispose?.();return;}
    setState({loading:false,error:'',warnings:result.warnings});
   }catch(e){if(!abort.signal.aborted)setState({loading:false,error:e instanceof Error?e.message:String(e),warnings:[]});}
  })();
  return ()=>{abort.abort();dispose?.();};
 },[blob,filename,attempt]);
 return <section aria-label="Office兼容预览">
  <p>兼容预览：字体、特殊图形及分页可能与 Office 原生显示不同。</p>
  {state.loading&&<p role="status">正在显示文档…</p>}
  {state.error&&<div role="alert">{state.error}<button onClick={()=>setAttempt(x=>x+1)}>重试预览</button></div>}
  {state.warnings.map((s,i)=><p key={i}>{s}</p>)}
  <div ref={host} style={{width:'100%',overflow:'auto'}} />
 </section>;
}
