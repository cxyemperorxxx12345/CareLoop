// 语音输入按钮：用浏览器内置语音识别（Web Speech API）把「打字」这道坎拆掉——
// 老人按一下、说句话，症状就进了输入框。设计约束对齐 SpeakButton：
// 不支持的浏览器（Firefox / 部分 Safari）直接不渲染，不给老人一个「点了没反应」的按钮；
// 识别失败只用「人话」toast 提示，绝不把原始错误码甩给用户。
// 本组件只负责把识别文本抛给父级（onResult），怎么合并进表单由父级决定。

import { Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const LANG = 'zh-CN';

// SpeechRecognition 未进入 TS 标准 DOM lib，这里只声明本组件用到的最小类型面（勿为此新增依赖）
/** 识别事件：results 为识别结果列表；interimResults=false 时全部是终稿 */
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: { length: number; [index: number]: { isFinal: boolean; [alt: number]: { transcript: string } } };
}

/** 错误事件：error 为 no-speech / not-allowed / network 等错误码 */
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}

/** 只声明用到的属性与回调，够用就好 */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

// 错误码 → 人话提示；aborted（用户主动结束）不需要提示
const ERROR_HINTS: Record<string, string> = {
  'no-speech': '没有听到声音，请靠近一点再试一次',
  'not-allowed': '请在浏览器设置中允许使用麦克风',
  'service-not-allowed': '请在浏览器设置中允许使用麦克风',
  'audio-capture': '没有检测到麦克风，请检查设备后重试',
  network: '网络异常，语音识别失败，请稍后重试',
};

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null; // SSR 安全：探测放到客户端
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function isSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export function VoiceInputButton({
  onResult,
  label = '输入框',
  className,
}: {
  /** 识别成功的最终文本——由父级决定怎么合并进输入框（本组件不碰表单状态） */
  onResult: (text: string) => void;
  /** 无障碍标签的宾语，如「主要症状」→ aria-label「用语音填写主要症状」 */
  label?: string;
  className?: string;
}) {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // 识别会话存活期间父组件可能重渲染，用 ref 拿最新回调，避免闭包过期导致覆盖旧文本
  const onResultRef = useRef(onResult);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  // 浏览器能力要挂载后才能探测（对齐 SpeakButton 的写法）
  useEffect(() => setAvailable(isSupported()), []);

  // 卸载/切页：立刻掐断录音，避免「跳页了麦克风灯还亮着」吓到用户
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  if (!available) return null;

  const settle = () => {
    recognitionRef.current = null;
    setListening(false);
  };

  const start = () => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      rec.lang = LANG; // 中文识别
      rec.continuous = false; // 说完一句自动结束，用户不用记「还要再点一下」
      rec.interimResults = false; // 只取终稿，避免中间稿闪动干扰
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        let text = '';
        for (let i = 0; i < event.results.length; i++) {
          const item = event.results[i];
          if (item.isFinal) text += item[0].transcript;
        }
        const final = text.trim();
        if (final) onResultRef.current(final);
      };
      rec.onerror = (event) => {
        if (event.error !== 'aborted') toast.error(ERROR_HINTS[event.error] ?? '语音识别失败，请重试');
      };
      rec.onend = settle;
      recognitionRef.current = rec;
      rec.start();
      setListening(true);
    } catch {
      toast.error('语音识别启动失败，请重试');
      settle();
    }
  };

  // 点击开始 / 再次点击结束
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop(); // stop 会收尾当前音频再触发 onend；若已在收尾中重复调用会抛错，静默即可
      } catch {
        /* onend 马上会到，无需处理 */
      }
      return;
    }
    start();
  };

  return (
    <button
      type="button"
      data-voice-button
      aria-pressed={listening}
      aria-label={listening ? `结束语音填写${label}` : `用语音填写${label}`}
      onClick={toggle}
      className={cn(
        // h-11 = 44px：适老化触控目标下限，老人手指点得准
        'inline-flex h-11 shrink-0 select-none items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors',
        listening
          ? 'border-destructive bg-destructive text-white'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      {listening ? (
        <>
          {/* 红色脉冲呼吸点：明确的「正在收音」状态反馈 */}
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
          </span>
          <Square className="h-4 w-4" aria-hidden />
          正在收音…
        </>
      ) : (
        <>
          <Mic className="h-4 w-4" aria-hidden />
          语音输入
        </>
      )}
    </button>
  );
}

export default VoiceInputButton;
