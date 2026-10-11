export function fault(code) { return new Error(code); }

export function parseStructured(text, validate) {
  if (typeof validate !== "function") throw fault("schema_validator_required");
  let raw = text.replace(/^\uFEFF/, "").trim();
  if (raw.startsWith("~~~")) throw fault("invalid_json");
  if (raw.charCodeAt(0) === 96) {
    const fence = String.fromCharCode(96).repeat(3);
    if (!raw.startsWith(fence) || !raw.endsWith(fence)) throw fault("invalid_json");
    raw = raw.slice(3, -3).replace(/^json\s*/i, "").trim();
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw fault("invalid_json"); }
  if (validate(value) !== true) throw fault("schema_validation_failed");
  return value;
}

export async function readChatResponse(response, {onText = () => {}, signal, maxChars = 1000000} = {}) {
  if (!response.ok) throw fault("http_" + response.status);
  const type = response.headers.get("content-type") || "";
  let text = "", reason = null, usage = null;
  function add(part) {
    if (typeof part !== "string") throw fault("invalid_content");
    if (text.length + part.length > maxChars) throw fault("output_too_large");
    text += part;
    if (part) onText(part, text);
  }
  function finish() {
    if (reason === "length") throw fault("output_truncated");
    if (reason === "content_filter") throw fault("content_filtered");
    if (reason === "tool_calls") throw fault("tool_calls_not_supported");
    if (reason !== "stop") throw fault("missing_finish_reason");
    if (!text.replace(/\uFEFF/g, "").trim()) throw fault("empty_content");
    return {content: text, finish_reason: reason, usage};
  }
  if (type.includes("application/json")) {
    let data;
    try { data = await response.json(); } catch { throw fault("invalid_json_response"); }
    if (signal?.aborted) throw fault("aborted");
    if (data.error || data.code) throw fault("upstream_error");
    const choice = data.choices?.[0];
    if (!choice || (choice.flag != null && choice.flag !== 0)) throw fault("invalid_or_filtered_response");
    reason = choice.finish_reason; usage = data.usage ?? null;
    add(choice.message?.content);
    return finish();
  }
  if (!type.includes("text/event-stream") || !response.body) throw fault("unexpected_content_type");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", {fatal:true});
  let buffer = "", lines = [], doneEvent = false;
  function dispatch() {
    if (!lines.length) return;
    const raw = lines.join("\n"); lines = [];
    if (raw.trim() === "[DONE]") { doneEvent = true; return; }
    let data;
    try { data = JSON.parse(raw); } catch { throw fault("invalid_sse_json"); }
    if (data.error || data.code) throw fault("upstream_stream_error");
    if (data.usage) usage = data.usage;
    if (Array.isArray(data.choices) && data.choices.length === 0 && data.usage) return;
    const choice = data.choices?.[0];
    if (!choice) throw fault("invalid_sse_shape");
    if (choice.flag != null && choice.flag !== 0) throw fault("content_filtered");
    if (choice.delta?.content != null) add(choice.delta.content);
    // reasoning_content is deliberately not treated as the final answer.
    if (choice.finish_reason != null) reason = choice.finish_reason;
  }
  function feed(chunk, eof = false) {
    buffer += chunk;
    while (!doneEvent) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0) break;
      if (!eof && buffer[index] === "\r" && index === buffer.length - 1) break;
      const line = buffer.slice(0, index);
      const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(index + width);
      if (line === "") dispatch();
      else if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
      // Comments, event, retry and id are SSE metadata, not content.
    }
    if (eof && !doneEvent) {
      if (buffer.startsWith("data:")) lines.push(buffer.slice(5).replace(/^ /, ""));
      buffer = ""; dispatch();
    }
  }
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, {once:true});
  try {
    if (signal?.aborted) throw fault("aborted");
    while (!doneEvent) {
      const next = await reader.read();
      if (signal?.aborted) throw fault("aborted");
      if (next.done) { feed(decoder.decode(), true); break; }
      feed(decoder.decode(next.value, {stream:true}));
    }
    if (!doneEvent) throw fault("incomplete_stream");
    return finish();
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
