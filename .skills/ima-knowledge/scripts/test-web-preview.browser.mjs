// Import this test from your Playwright runner after serving the two ESM modules locally.
import assert from 'node:assert/strict';
export async function testWebPreview(page,{moduleUrl,purifyUrl}) {
 const result=await page.evaluate(async({moduleUrl,purifyUrl})=>{
  const {readWebBlob,webSnapshot}=await import(moduleUrl);const {default:purify}=await import(purifyUrl);
  const sample='<html><head><style>h1{color:rgb(0,128,0)}</style></head><body><h1>中文静态网页</h1><p>正文</p><script>parent.hacked=1</script><img onerror="parent.hacked=1" src="https://unapproved.example/x"><form><input></form><iframe src="/leak"></iframe><a href="javascript:alert(1)">bad</a></body></html>';
  const html=await readWebBlob(new Blob([sample],{type:'text/html'}));
  const clean=webSnapshot(html,{purify});const d=new DOMParser().parseFromString(clean,'text/html');
  let invalidRejected=0;
  for(const blob of [new Blob([]),new Blob(['{}'],{type:'application/json'}),new Blob(['%PDF-1.7'],{type:'application/octet-stream'})])try{await readWebBlob(blob);}catch{invalidRejected++;}
  const f=document.createElement('iframe');f.id='web-preview-test';f.sandbox='';f.srcdoc=clean;document.body.append(f);
  return {invalidRejected,bad:d.querySelectorAll('script,form,iframe,[onerror],[href^="javascript:"]').length,imageSrc:d.querySelector('img').getAttribute('src'),csp:d.querySelector('meta[http-equiv="Content-Security-Policy"]').content};
 },{moduleUrl,purifyUrl});
 assert.equal(result.invalidRejected,3);assert.equal(result.bad,0);assert.equal(result.imageSrc,null);assert.ok(result.csp.includes("script-src 'none'"));
 const frame=page.frameLocator('#web-preview-test');await frame.getByRole('heading',{name:'中文静态网页'}).waitFor();
 assert.equal(await frame.locator('h1').evaluate(el=>getComputedStyle(el).color),'rgb(0, 128, 0)');
 assert.equal(await page.evaluate(()=>window.hacked),undefined);
 await page.locator('#web-preview-test').evaluate(el=>el.remove());
 return 'PASS real iframe: Chinese text, inline CSS, sanitizer, no script execution, invalid input rejection';
}
