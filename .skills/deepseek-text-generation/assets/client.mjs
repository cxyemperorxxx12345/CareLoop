import {readChatResponse, parseStructured} from "./chat-runtime.mjs";

// Only pass platform public Supabase configuration / the current user session.
// Never pass INTEGRATIONS_API_KEY to this function.
export async function generateText({
  supabaseUrl, publicAnonKey, sessionAccessToken, messages,
  model, stream=true, maxTokens=4096, validate, signal, onText=()=>{},
  onState=()=>{}, fetchImpl=fetch, timeoutMs=125000,
}) {
  const aborter = new AbortController();
  const abort = () => aborter.abort();
  signal?.addEventListener("abort",abort,{once:true});
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  onState("loading");
  try {
    const response = await fetchImpl(
      supabaseUrl.replace(/\/$/, "") + "/functions/v1/deepseek-text-generation",
      {
        method:"POST",
        headers:{"Content-Type":"application/json",apikey:publicAnonKey,
          Authorization:"Bearer "+(sessionAccessToken || publicAnonKey)},
        body:JSON.stringify({messages,stream,max_tokens:maxTokens,...(model !== undefined ? {model} : {})}),
        signal:aborter.signal,
      },
    );
    const result = await readChatResponse(response, {
      signal:aborter.signal,
      onText:(delta,all) => {onState("streaming"); onText(delta,all);},
    });
    const value = validate ? parseStructured(result.content,validate) : result.content;
    onState("success");
    return {...result,value};
  } catch (error) {
    onState(signal?.aborted ? "canceled" : "error");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort",abort);
  }
}
