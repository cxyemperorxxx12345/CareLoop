import {parseStructured} from './chat-runtime.mjs';

// No TextDecoder/ReadableStream/AbortController requirement in the mini-program.
export function createMiniParser({onText=()=>{},maxChars=1000000}={}) {
  let pending=[], buffer='', lines=[], text='', reason=null, usage=null, done=false, first=true, wire=0;
  function decode(bytes, eof=false) {
    const a=pending.concat(Array.from(bytes)); pending=[]; let out='',i=0;
    while(i<a.length) {
      const b=a[i]; let n,cp,min;
      if(b<128){n=1;cp=b;min=0;}
      else if(b>=194&&b<=223){n=2;cp=b&31;min=128;}
      else if(b>=224&&b<=239){n=3;cp=b&15;min=2048;}
      else if(b>=240&&b<=244){n=4;cp=b&7;min=65536;}
      else throw new Error('invalid_utf8');
      if(i+n>a.length){pending=a.slice(i);break;}
      for(let j=1;j<n;j++){if((a[i+j]&192)!==128)throw new Error('invalid_utf8');cp=(cp<<6)|(a[i+j]&63);}
      if(cp<min||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff))throw new Error('invalid_utf8');
      out+=String.fromCodePoint(cp);i+=n;
    }
    if(eof&&pending.length)throw new Error('incomplete_utf8');
    return out;
  }
  function event() {
    if(!lines.length)return;
    const raw=lines.join('\n');lines=[];
    if(raw.trim()==='[DONE]'){done=true;return;}
    let d;try{d=JSON.parse(raw);}catch{throw new Error('invalid_sse_json');}
    if(d.error||d.code)throw new Error('upstream_stream_error');
    if(d.usage)usage=d.usage;
    if(Array.isArray(d.choices)&&!d.choices.length&&d.usage)return;
    const c=d.choices?.[0];if(!c)throw new Error('invalid_sse_shape');
    if(c.flag!=null&&c.flag!==0)throw new Error('content_filtered');
    if(c.delta?.content!=null){
      const v=c.delta.content;if(typeof v!=='string')throw new Error('invalid_content');
      if(text.length+v.length>maxChars)throw new Error('output_too_large');
      text+=v;if(v)onText(v,text);
    }
    if(c.finish_reason!=null)reason=c.finish_reason;
  }
  function line(s){if(s==='')event();else if(s.startsWith('data:'))lines.push(s.slice(5).replace(/^ /,''));}
  function feed(s,eof=false){
    if(first&&s.length){s=s.replace(/^\uFEFF/,'');first=false;}
    buffer+=s;
    while(!done){
      const i=buffer.search(/[\r\n]/);if(i<0)break;
      if(!eof&&buffer[i]==='\r'&&i===buffer.length-1)break;
      const width=buffer[i]==='\r'&&buffer[i+1]==='\n'?2:1;
      const v=buffer.slice(0,i);buffer=buffer.slice(i+width);line(v);
    }
    if(eof&&!done){if(buffer)line(buffer);buffer='';event();}
    if(buffer.length>maxChars||lines.reduce((n,v)=>n+v.length,0)>maxChars)throw new Error('frame_too_large');
  }
  return {
    push(data){
      if(done)return;
      const bytes=data instanceof ArrayBuffer?new Uint8Array(data):data;
      if(!(bytes instanceof Uint8Array))throw new Error('invalid_chunk');
      wire+=bytes.byteLength;if(wire>maxChars*12)throw new Error('stream_too_large');
      feed(decode(bytes));
    },
    finish(){
      feed(decode([],true),true);
      if(!done)throw new Error('incomplete_stream');
      if(reason==='length')throw new Error('output_truncated');
      if(reason==='content_filter')throw new Error('content_filtered');
      if(reason!=='stop')throw new Error('invalid_finish_reason');
      if(!text.replace(/\uFEFF/g,'').trim())throw new Error('empty_content');
      return {content:text,finish_reason:reason,usage};
    },
  };
}

// Pass request: options => Taro.request(options), or wx.request(options).
// This is NOT async: callers must receive abort() immediately.
export function generateMiniText({request,supabaseUrl,publicAnonKey,sessionAccessToken,
  messages,model,maxTokens=4096,timeoutMs=125000,maxChars=1000000,
  onText=()=>{},onState=()=>{},validate}={}) {
  let task,settled=false,timer,resolve,reject,headerOK=false,queued=[],queuedBytes=0;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const parser=createMiniParser({maxChars,onText:(part,all)=>{onState('streaming');onText(part,all);}});
  const cleanup=()=>{clearTimeout(timer);task?.offChunkReceived?.(chunk);task?.offHeadersReceived?.(headers);queued=[];};
  function fail(code,state='error'){
    if(settled)return;settled=true;cleanup();
    try{task?.abort?.();}finally{onState(state);reject(new Error(code));}
  }
  function checkHeaders(header={}){
    const entry=Object.entries(header).find(([k])=>k.toLowerCase()==='content-type');
    if(!String(entry?.[1]||'').toLowerCase().includes('text/event-stream'))throw new Error('unexpected_content_type');
    headerOK=true;
    for(const data of queued)parser.push(data);queued=[];queuedBytes=0;
  }
  function headers(res){if(settled)return;try{checkHeaders(res.header);}catch(e){fail(e.message);}}
  function chunk(res){
    if(settled)return;
    try{
      if(headerOK)parser.push(res.data);
      else {queuedBytes+=res.data.byteLength;if(queuedBytes>maxChars*12)throw new Error('stream_too_large');queued.push(res.data);}
    }catch(e){fail(e.message);}
  }
  onState('loading');
  try{
    if(typeof request!=='function'||!supabaseUrl||!publicAnonKey)throw new Error('missing_configuration');
    const url=supabaseUrl.replace(/\/$/,'')+'/functions/v1/deepseek-text-generation';
    if(!url.startsWith('https://'))throw new Error('https_required');
    timer=setTimeout(()=>fail('timeout'),timeoutMs);
    task=request({url,method:'POST',enableChunked:true,responseType:'arraybuffer',dataType:'text',timeout:timeoutMs,
      header:{'Content-Type':'application/json',Accept:'text/event-stream',apikey:publicAnonKey,
        Authorization:'Bearer '+(sessionAccessToken||publicAnonKey)},
      data:{messages,stream:true,max_tokens:maxTokens,...(model !== undefined ? {model} : {})},
      success(res){
        if(settled)return;
        try{
          if(res.statusCode<200||res.statusCode>=300)throw new Error('http_'+res.statusCode);
          if(!headerOK)checkHeaders(res.header);
          // res.data may repeat all chunks: never append it again.
          const result=parser.finish();
          const value=validate?parseStructured(result.content,validate):result.content;
          settled=true;cleanup();onState('success');resolve({...result,value});
        }catch(e){fail(e.message);}
      },
      fail(){fail('network_or_request_failed');},
    });
    // Taro returns a thenable task in some versions. Handle rejection as well as callbacks.
    task?.catch?.(()=>{});
    if(typeof task?.onChunkReceived!=='function'||typeof task?.onHeadersReceived!=='function')throw new Error('streaming_not_supported');
    if(settled){task.abort?.();return {promise,abort:()=>{}};}
    task.onHeadersReceived(headers);task.onChunkReceived(chunk);
  }catch(e){fail(e.message);}
  return {promise,abort:()=>fail('aborted','canceled')};
}
