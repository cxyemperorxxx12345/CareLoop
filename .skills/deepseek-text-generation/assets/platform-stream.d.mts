import type {MiniResult,MiniRequestOptions,MiniRequestTask} from './mini-stream.mjs';
export interface PlatformStreamOptions {
  platform:'h5'|'weapp';
  request?:(options:MiniRequestOptions)=>MiniRequestTask;
  supabaseUrl:string;publicAnonKey:string;sessionAccessToken?:string;
  messages:Array<{role:string;content:string}>;
  model?:'deepseek-v4-pro-0813'|'deepseek-v4.1-flash';
  maxTokens?:number;timeoutMs?:number;maxChars?:number;
  onText?:(delta:string,all:string)=>void;
  onState?:(state:'loading'|'streaming'|'success'|'error'|'canceled')=>void;
  validate?:(value:unknown)=>boolean;
  fetchImpl?:typeof fetch;
}
export function generatePlatformText(options:PlatformStreamOptions):{
  promise:Promise<MiniResult>;abort():void;
};
