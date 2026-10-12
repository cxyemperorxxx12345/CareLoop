// 智能问答：对话式 UI + assistant-chat Edge Function SSE 流式输出

import { AlertTriangle, Bot, PhoneCall, SendHorizonal, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Streamdown } from 'streamdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/db/supabase';
import { getMyPatient } from '@/lib/api';

// 识别是否需要联系医护 / 就诊
const ESCALATION_PATTERN = /(就医|急诊|就诊|联系医生|联系医护|去医院|随访电话|拨打|紧急|危险信号|心内科|心外科|立即前往)/;

// 剥离 <think>…</think> 思考过程：未闭合时返回空串（思考中），闭合后仅返回正文回答
function stripThink(raw: string): string {
  const open = raw.indexOf('<think>');
  if (open === -1) return raw;
  const close = raw.indexOf('</think>');
  if (close === -1) return '';
  return (raw.slice(0, open) + raw.slice(close + '</think>'.length)).trim();
}

// 会话消息：用户 / 助手气泡
interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

const EXAMPLE_QUESTIONS = ['我现在的药需要空腹吃吗？', '术后伤口有点发红，要紧吗？', '出院后血压控制在多少合适？'];

// 思考中占位：文字呼吸闪烁 + 三点依次弹跳。
// 必须是「会动的」——老人看到静止画面容易以为 App 卡死，这里明确表达"正在生成"。
function ThinkingIndicator() {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span className="animate-pulse font-medium text-primary">回复正在生成中</span>
      <span className="inline-flex items-end gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
    </span>
  );
}

export function AssistantPage() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [syncedAlertIds, setSyncedAlertIds] = useState<Record<number, boolean>>({});
  const [patientInfo, setPatientInfo] = useState<{ id: string; name: string; department?: string } | null>(null);
  const idRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    getMyPatient().then((p) => {
      if (p) setPatientInfo(p as { id: string; name: string; department?: string });
    }).catch(() => undefined);
  }, []);

  // 一键同步到医护端：在 alerts 表写入一条待办预警，并通知患者
  const syncToClinician = async (msgId: number, content: string) => {
    if (!patientInfo) {
      toast.error('未找到患者信息');
      return;
    }
    if (syncedAlertIds[msgId]) {
      toast.info('已同步过，请勿重复操作');
      return;
    }
    try {
      const summary = content.slice(0, 120);
      const { error } = await supabase.from('alerts').insert({
        patient_id: patientInfo.id,
        level: 'yellow',
        source: 'symptom',
        detail: `【患者咨询上报】${summary}…`,
        status: 'open',
        assignee_role: 'clinician',
      });
      if (error) throw new Error(error.message);
      setSyncedAlertIds((prev) => ({ ...prev, [msgId]: true }));
      toast.success('已一键同步到医护端预警中心，随访护士将尽快查看');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '同步失败，请稍后重试');
    }
  };

  // 新消息或流式内容更新时滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 输入框自动高度（最高约 5 行）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const appendMsg = (msg: Omit<ChatMsg, 'id'>) => {
    const id = idRef.current++;
    setMessages((prev) => [...prev, { ...msg, id }]);
    return id;
  };

  // 流式更新当前助手消息（剥离思考过程，仅渲染最终回答；思考中保持空串显示占位）
  const updateAssistant = (id: number, raw: string) => {
    const answer = stripThink(raw);
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: answer } : m)));
  };

  // 发起提问：SSE 逐行解析 data: 前缀，累加 delta.content 实时渲染
  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || sending) return;
    appendMsg({ role: 'user', content: q });
    setInput('');
    setSending(true);
    const assistantId = appendMsg({ role: 'assistant', content: '' });
    let acc = '';
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('登录状态已失效，请重新登录');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/assistant-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok || !res.body) throw new Error(`请求失败（${res.status}），请稍后重试`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data: ')) continue;
          const payload = t.slice(6).trim();
          // 跳过结束标记与 usage 统计行
          if (!payload || payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: unknown;
            };
            if (json.usage) continue;
            const delta = json.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              acc += delta;
              updateAssistant(assistantId, acc);
            }
          } catch {
            // 忽略无法解析的行
          }
        }
      }
      if (!stripThink(acc)) updateAssistant(assistantId, '暂时没有获得回答，请换个问法再试一次。');
    } catch (e) {
      // 出错保留已生成内容，仅提示
      if (!stripThink(acc)) updateAssistant(assistantId, '回答中断了，请稍后重试。');
      toast.error(e instanceof Error ? e.message : '助手暂时不可用，请稍后重试');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col">
      {/* 消息列表 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          // 空态：欢迎语 + 示例问题胶囊
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10">
              <Bot className="h-6 w-6 text-primary" />
            </span>
            <div>
              <p className="text-base font-bold">愈见助手</p>
              <p className="mt-1 text-sm text-muted-foreground">出院康复相关问题，随时可以问我</p>
            </div>
            <div className="flex w-full flex-col gap-2">
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => ask(q)}
                  className="w-full rounded-2xl border border-border bg-card px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => {
            const isUser = m.role === 'user';
            return (
              <div key={m.id} className={isUser ? 'flex justify-end' : 'flex justify-start'}>
                {!isUser && (
                  <span className="mt-0.5 mr-2 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10">
                    <Bot className="h-4 w-4 text-primary" />
                  </span>
                )}
                <div
                  className={
                    isUser
                      ? 'max-w-[80%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground'
                      : 'max-w-[80%] rounded-2xl rounded-bl-md border border-border bg-card px-3.5 py-2.5'
                  }
                >
                  {!isUser && <p className="mb-1 text-xs font-medium text-muted-foreground">愈见助手</p>}
                  {isUser ? (
                    m.content
                  ) : m.content ? (
                    <>
                      <Streamdown className="text-sm [&_a]:text-primary [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-4 [&_ul]:list-disc [&_ul]:pl-4 [&_p]:leading-relaxed">
                        {m.content}
                      </Streamdown>
                      {/* 若助手建议就诊/联系医护，跳出一键动作卡片 */}
                      {ESCALATION_PATTERN.test(m.content) && (
                        <div className="mt-3 rounded-xl border border-triage-amber/30 bg-triage-amber-bg/50 p-2.5 text-xs space-y-2">
                          <div className="flex items-center gap-1.5 font-bold text-triage-amber">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                            <span>助手提示：该情况建议与医护团队确认</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="default"
                              disabled={syncedAlertIds[m.id]}
                              onClick={() => syncToClinician(m.id, m.content)}
                              className="h-8 rounded-lg text-xs gap-1 shadow-sm"
                            >
                              <ShieldAlert className="h-3.5 w-3.5" />
                              {syncedAlertIds[m.id] ? '已同步医护端' : '一键同步到医护端'}
                            </Button>
                            <a
                              href="tel:010-88886666"
                              className="inline-flex items-center gap-1 h-8 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                            >
                              <PhoneCall className="h-3.5 w-3.5 text-primary" />
                              直拨随访科室
                            </a>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <ThinkingIndicator />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 底部固定输入栏 */}
      <div className="border-t border-border bg-background p-3">
        <div className="flex items-end gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            rows={1}
            placeholder="输入您的问题…"
            className="max-h-30 flex-1 resize-none rounded-2xl text-sm"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter 发送，Shift+Enter 换行
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
          />
          <Button
            type="button"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-full"
            disabled={!input.trim() || sending}
            onClick={() => ask(input)}
            aria-label="发送"
          >
            <SendHorizonal className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
export default AssistantPage;
