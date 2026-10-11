import {generateMiniText} from './mini-stream.mjs';
import {generateText} from './client.mjs';

// Explicit Taro build target, not UI/product type. H5 preview is always h5.
// Returns the same immediate {promise, abort} handle for both runtimes.
export function generatePlatformText({platform,request,...options}) {
  if(platform==='weapp')return generateMiniText({...options,request});
  if(platform==='h5'){
    const controller=new AbortController();
    const promise=generateText({...options,stream:true,signal:controller.signal});
    return {promise,abort:()=>controller.abort()};
  }
  options.onState?.('error');
  return {promise:Promise.reject(new Error('unsupported_platform')),abort:()=>{}};
}
