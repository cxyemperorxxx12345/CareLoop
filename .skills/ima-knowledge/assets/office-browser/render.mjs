import {PptxViewer, RECOMMENDED_ZIP_LIMITS} from './vendor/pptx.mjs';
import {paginateDocx} from './paginate.mjs';
const sessions=new WeakMap();
const loadScript=(name)=>new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=new URL('./vendor/'+name,import.meta.url).href;el.onload=resolve;el.onerror=()=>reject(Error('预览资源加载失败：'+name));document.head.append(el);});
let ready;
async function dependencies(){if(!ready)ready=(async()=>{await loadScript('jszip.js');await loadScript('docx.js');})().catch(e=>{ready=null;throw e;});await ready;}
export async function renderBrowserOffice({data,filename,container,signal}) {
 if(!(data instanceof ArrayBuffer)||!data.byteLength)throw Error('Office原文件为空或不是ArrayBuffer');
 if(data.byteLength>25*1024*1024)throw Error('Office预览限制25MiB');
 const ext=String(filename).toLowerCase().match(/\.(docx|pptx)$/)?.[1];
 if(!ext)throw Error('此浏览器实现仅支持DOCX/PPTX，不将DOC/PPT伪装为新格式');
 const token={};sessions.set(container,token);
 const stale=()=>signal?.aborted||sessions.get(container)!==token;
 const aborted=()=>new DOMException('Preview cancelled','AbortError');
 await dependencies();if(stale())throw aborted();
 const zip=await window.JSZip.loadAsync(data);
 const files=Object.values(zip.files);
 if(files.length>2500||files.reduce((n,f)=>n+(f._data?.uncompressedSize||0),0)>100*1024*1024)throw Error('Office解压体积或文件数超限');
 if(!zip.file(ext==='docx'?'word/document.xml':'ppt/presentation.xml'))throw Error('文件内容与Office扩展名不符');
 for(const file of files.filter(f=>f.name.endsWith('.rels'))){const xml=new DOMParser().parseFromString(await file.async('string'),'application/xml');for(const rel of xml.querySelectorAll('Relationship'))if(rel.getAttribute('TargetMode')==='External'&&!rel.getAttribute('Type')?.endsWith('/hyperlink'))throw Error('文档包含外部资源；此预览仅使用文件内嵌资源');}
 if(stale())throw aborted();
 const stage=document.createElement('div');stage.style.cssText='visibility:hidden;position:relative;';container.replaceChildren(stage);container.style.overflow='auto';
 let viewer;
 const cleanup=()=>{viewer?.destroy?.();stage.remove();};
 try{
  let result;
  if(ext==='pptx') {stage.style.width=Math.max(320,container.clientWidth||900)+'px';viewer=await PptxViewer.open(data,stage,{zipLimits:RECOMMENDED_ZIP_LIMITS,pdfjs:false,listOptions:{windowed:false}});result={format:ext,pages:Object.keys(zip.files).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p)).length,warnings:['浏览器版式预览；字体、特殊图形可能与Office原生显示不同。']};}
  else {await window.docx.renderAsync(data,stage,null,{breakPages:true,ignoreWidth:false,ignoreHeight:false});result={format:ext,...await paginateDocx(stage)};result.warnings.unshift('浏览器分页预览；页码可能与Word原生分页不同。');}
  await document.fonts.ready;if(stale())throw aborted();
  stage.querySelectorAll('a').forEach(a=>{const href=a.getAttribute('href')||'';if(!/^(https?:|#)/i.test(href))a.removeAttribute('href');else{a.target='_blank';a.rel='noopener noreferrer';}});
  stage.style.visibility='visible';
  signal?.addEventListener('abort',cleanup,{once:true});
  return {...result,dispose(){signal?.removeEventListener('abort',cleanup);cleanup();}};
 }catch(e){cleanup();throw e;}
}
