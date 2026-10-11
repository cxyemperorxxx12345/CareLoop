// CareLoop Edge Functions 共享 MiniMax-M3 网关调用
// 网关为本应用专属托管网关，INTEGRATIONS_API_KEY 仅发往该域名

const GATEWAY_URL =
  'https://app-ezvlp6ds1hqa-api-rLobPAn0n7m9-gateway.miaoda.online/v1/chat/completions';

interface MiniMaxMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  name?: string;
}

function getApiKey(): string {
  const key = Deno.env.get('INTEGRATIONS_API_KEY');
  if (!key) throw new Error('AI 网关配置缺失');
  return key;
}

// 非流式调用：返回上游响应 JSON；base_resp.status_code!==0 视为失败
export async function callMiniMaxJson(
  messages: MiniMaxMessage[],
  opts: { maxCompletionTokens?: number; temperature?: number } = {},
): Promise<unknown> {
  const upstream = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gateway-Authorization': `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      thinking: { type: 'adaptive' },
      stream: false,
      temperature: opts.temperature ?? 0.6,
      max_completion_tokens: opts.maxCompletionTokens ?? 4096,
      messages,
    }),
  });

  if (!upstream.ok) {
    throw new Error(`AI 网关 HTTP ${upstream.status}`);
  }
  const data = await upstream.json();
  const base = (data as { base_resp?: { status_code?: number; status_msg?: string } }).base_resp;
  if (base && base.status_code !== 0) {
    throw new Error(`AI 网关错误 ${base.status_code}: ${base.status_msg ?? '未知错误'}`);
  }
  return data;
}

// 提取非流式响应中的文本内容
export function extractContent(data: unknown): string {
  const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

// 从模型输出中稳健提取 JSON 对象（容忍 ```json 包裹与前后噪音）
export function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('模型输出中未找到 JSON 对象');
  }
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

// 流式调用：直接返回可透传给浏览器的 SSE 响应（调用方负责错误处理）
export async function callMiniMaxStream(messages: MiniMaxMessage[]): Promise<Response> {
  const upstream = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gateway-Authorization': `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      thinking: { type: 'adaptive' },
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.6,
      max_completion_tokens: 4096,
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const msg = `AI 网关 HTTP ${upstream.status}`;
    return new Response(JSON.stringify({ error: msg }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
