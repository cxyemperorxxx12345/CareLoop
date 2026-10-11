import {readChatResponse} from "./chat-runtime.mjs";
export const ENDPOINT = "https://app-ezvlp6ds1hqa-api-ra5E8QRXA0wa-gateway.miaoda.online/v2/chat/completions";
export const MODEL = "deepseek-v4-pro-0813";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const json = (value, status=200) => Response.json(value, {status, headers:cors});
export function createHandler({getKey, fetchImpl=fetch, endpoint=ENDPOINT, timeoutMs=120000}) {
  return async function handler(req) {
    if (req.method === "OPTIONS") return new Response(null, {headers:cors});
    if (req.method !== "POST") return json({error:"method_not_allowed"},405);
    let input;
    try { input = await req.json(); } catch { return json({error:"invalid_request_json"},400); }
    const messages = input?.messages;
    if (!Array.isArray(messages) || !messages.length || messages.some(m =>
      !["system","user","assistant"].includes(m?.role) || typeof m.content !== "string" || !m.content.trim()
    )) return json({error:"invalid_messages"},400);
    if (input.stream !== undefined && typeof input.stream !== "boolean")
      return json({error:"invalid_stream"},400);
    const model = input.model ?? MODEL;
    if (![MODEL, "deepseek-v4.1-flash"].includes(model)) return json({error:"invalid_model"},400);
    const maxTokens = input.max_tokens ?? 4096;
    if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 16384)
      return json({error:"invalid_output_budget"},400); // Application guard, not model maximum.
    if (JSON.stringify(messages).length > 100000) return json({error:"input_too_large"},413);
    const key = getKey();
    if (!key || endpoint.includes("API_ID@")) return json({error:"gateway_not_configured"},503);
    const payload = {model, messages, stream:input.stream ?? true, max_tokens:maxTokens, thinking:{type:"disabled"}};
    if (payload.stream) payload.stream_options = {include_usage:true};
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.signal.addEventListener("abort", abort, {once:true});
    if (req.signal.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    const cleanup = () => {clearTimeout(timer); req.signal.removeEventListener("abort", abort);};
    let upstream;
    try {
      upstream = await fetchImpl(endpoint, {
        method:"POST",
        headers:{"Content-Type":"application/json", "X-Gateway-Authorization":"Bearer "+key},
        body:JSON.stringify(payload), signal:controller.signal,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        cleanup();
        return json({error:"upstream_http_error",status:upstream.status},
          upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
      }
      const contentType = upstream.headers.get("content-type") || "";
      if (!payload.stream || contentType.includes("application/json")) {
        const result = await readChatResponse(upstream, {signal:controller.signal});
        cleanup();
        return json({choices:[{message:{role:"assistant",content:result.content},
          finish_reason:result.finish_reason}], usage:result.usage});
      }
      if (!contentType.includes("text/event-stream")) {
        await upstream.body?.cancel(); cleanup(); return json({error:"unexpected_content_type"},502);
      }
      const encoder = new TextEncoder();
      let canceled = false;
      const body = new ReadableStream({
        start(out) {
          const send = data => {if (!canceled) out.enqueue(encoder.encode("data: "+JSON.stringify(data)+"\n\n"));};
          readChatResponse(upstream, {
            signal:controller.signal,
            onText:part => send({choices:[{delta:{content:part},finish_reason:null}]}),
          }).then(result => {
            send({choices:[{delta:{},finish_reason:"stop"}],usage:result.usage});
            if (!canceled) out.enqueue(encoder.encode("data: [DONE]\n\n"));
          }).catch(() => {
            send({error:{code:controller.signal.aborted ? "stream_timeout_or_aborted" : "stream_failed",
              message:"生成中断或输出不完整，请重试或缩小单次输出。"}});
          }).finally(() => {cleanup(); if (!canceled) out.close();});
        },
        cancel() {canceled=true; controller.abort(); cleanup();},
      });
      return new Response(body, {headers:{...cors,"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache"}});
    } catch {
      controller.abort(); cleanup();
      return json({error:controller.signal.aborted ? "generation_failed_or_timeout" : "generation_failed"},502);
    }
  };
}
