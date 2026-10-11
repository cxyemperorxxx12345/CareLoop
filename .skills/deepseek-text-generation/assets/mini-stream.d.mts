export interface MiniResult {content:string;finish_reason:string;usage:unknown;value?:unknown;}
export interface MiniRequestTask {
  abort():void;
  onChunkReceived?(handler:(event:{data:ArrayBuffer})=>void):void;
  offChunkReceived?(handler:(event:{data:ArrayBuffer})=>void):void;
  onHeadersReceived?(handler:(event:{header:Record<string,unknown>})=>void):void;
  offHeadersReceived?(handler:(event:{header:Record<string,unknown>})=>void):void;
  catch?(handler:(error:unknown)=>void):unknown;
}
export interface MiniRequestOptions {
  url:string;method:'POST';enableChunked:true;responseType:'arraybuffer';dataType:'text';timeout:number;
  header:Record<string,string>;
  data:{messages:Array<{role:string;content:string}>;model?:'deepseek-v4-pro-0813'|'deepseek-v4.1-flash';stream:true;max_tokens:number};
  success(response:{statusCode:number;header?:Record<string,unknown>;data?:unknown}):void;
  fail(error?:unknown):void;
}
export function createMiniParser(options?:{onText?:(delta:string,all:string)=>void;maxChars?:number}):{
  push(data:ArrayBuffer|Uint8Array):void;finish():MiniResult;
};
export function generateMiniText(options:{
  request:(options:MiniRequestOptions)=>MiniRequestTask;
  supabaseUrl:string;publicAnonKey:string;sessionAccessToken?:string;
  messages:Array<{role:string;content:string}>;model?:'deepseek-v4-pro-0813'|'deepseek-v4.1-flash';maxTokens?:number;timeoutMs?:number;maxChars?:number;
  onText?:(delta:string,all:string)=>void;
  onState?:(state:'loading'|'streaming'|'success'|'error'|'canceled')=>void;
  validate?:(value:unknown)=>boolean;
}):{promise:Promise<MiniResult>;abort():void};
