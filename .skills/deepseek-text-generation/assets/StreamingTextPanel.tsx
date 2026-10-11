import {useEffect,useRef,useState} from 'react';
import Taro,{useUnload} from '@tarojs/taro';
import {View,Text,Button} from '@tarojs/components';
import {generatePlatformText} from './platform-stream.mjs';
import type {MiniResult} from './mini-stream.mjs';

// Copy this with all client-side .mjs/.d.mts dependencies. No server keys.
export function StreamingTextPanel({messages,supabaseUrl,publicAnonKey,sessionAccessToken,validate,onResult}:{
  messages:Array<{role:string;content:string}>;
  supabaseUrl:string;publicAnonKey:string;sessionAccessToken?:string;
  validate?:(value:unknown)=>boolean;onResult?:(result:MiniResult)=>void;
}){
  const [model,setModel]=useState<'deepseek-v4-pro-0813'|'deepseek-v4.1-flash'>('deepseek-v4-pro-0813');
  const [text,setText]=useState('');
  const [state,setState]=useState('idle');
  const [error,setError]=useState('');
  const seq=useRef(0);
  const active=useRef<{abort():void}|null>(null);
  const dispose=()=>{seq.current++;active.current?.abort();active.current=null;};
  useUnload(dispose);
  useEffect(()=>()=>{seq.current++;active.current?.abort();},[]);
  async function start(){
    const id=++seq.current;
    active.current?.abort();setText('');setError('');
    // getEnv() reflects H5 preview vs actual WeChat runtime, not app project type.
    const env=Taro.getEnv();
    const platform=env===Taro.ENV_TYPE.WEB?'h5':env===Taro.ENV_TYPE.WEAPP?'weapp':null;
    if(!platform){setState('error');setError('当前运行环境尚不支持此流式入口');return;}
    const run=generatePlatformText({
      platform,
      request:options=>Taro.request(options),
      model,messages,supabaseUrl,publicAnonKey,sessionAccessToken,validate,
      onText:(_delta,all)=>{if(id===seq.current)setText(all);},
      onState:s=>{if(id===seq.current)setState(s);},
    });
    active.current=run;
    try{const result=await run.promise;if(id===seq.current)onResult?.(result);}
    catch(e){if(id===seq.current)setError(e instanceof Error&&e.message==='aborted'?'已停止，以上内容未完成':'生成未完成，请重试；已保留收到的内容');}
    finally{if(id===seq.current)active.current=null;}
  }
  const busy=state==='loading'||state==='streaming';
  return <View>
    <View>
      <Text>选择模型：{model==='deepseek-v4-pro-0813'?'DeepSeek V4 Pro':'DeepSeek V4.1 Flash'}</Text>
      <Button disabled={busy} onClick={()=>setModel('deepseek-v4-pro-0813')}>DeepSeek V4 Pro（默认）</Button>
      <Button disabled={busy} onClick={()=>setModel('deepseek-v4.1-flash')}>DeepSeek V4.1 Flash</Button>
    </View>
    <Button disabled={busy} onClick={start}>生成</Button>
    {busy&&<Button onClick={()=>active.current?.abort()}>停止</Button>}
    <Text>{state==='streaming'?'正在接收正文…':state==='success'?'生成完成':state==='loading'?'等待模型响应…':''}</Text>
    {/* Real incremental body; not only a spinner. JSON is raw text until validated. */}
    <View style={{whiteSpace:'pre-wrap',wordBreak:'break-all'}}><Text selectable>{text}</Text></View>
    {error&&<Text>{error}</Text>}
  </View>;
}
