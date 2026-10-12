// 朗读按钮：用浏览器内置语音（Web Speech API）把文字念出来
// 面向出院后的中老年用户——他们最常见的障碍不是「没有信息」，而是看不清、看不动长段文字。
// 设计约束：不支持的浏览器直接不渲染（不给点了没反应的按钮）；用户点击才念，绝不自动播放；
// 组件卸载/切页立刻 cancel，避免「跳页了还在念」。

import { Square, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';

// 语速稍慢，老人听得清；这是产品默认值，不暴露给用户调
const RATE = 0.9;
const LANG = 'zh-CN';

type SpeakerHandle = { stop: () => void };

// 同一时刻只允许一处朗读：新按钮开念前，先让页面上其它朗读按钮复位
const liveSpeakers = new Set<SpeakerHandle>();

function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

export function SpeakButton({
  text,
  label = '这段内容',
  size = 'sm',
  className,
}: {
  // 要朗读的文本；为空时不渲染按钮
  text: string;
  // 无障碍标签的宾语，如「这条消息」「这段建议」→ aria-label「朗读这条消息」
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const [available, setAvailable] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const timerRef = useRef<number | null>(null);
  const handleRef = useRef<SpeakerHandle | null>(null);

  // 浏览器是否具备语音能力要到客户端才知道，挂载后再决定渲染
  useEffect(() => setAvailable(isSupported()), []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 回到未播放态：清定时器、丢弃 utterance
  const settle = useCallback(() => {
    clearTimer();
    utteranceRef.current = null;
    setSpeaking(false);
  }, [clearTimer]);

  const stop = useCallback(() => {
    if (!isSupported()) return;
    window.speechSynthesis.cancel();
    settle();
  }, [settle]);

  useEffect(() => {
    const handle: SpeakerHandle = { stop };
    handleRef.current = handle;
    liveSpeakers.add(handle);
    return () => {
      liveSpeakers.delete(handle);
      handleRef.current = null;
      // 卸载（切页、关弹窗）：只在自己正在念时打断，不影响别处
      if (utteranceRef.current) window.speechSynthesis.cancel();
      clearTimer();
    };
  }, [stop, clearTimer]);

  if (!available || !text.trim()) return null;

  const start = () => {
    const content = text.trim();
    const synth = window.speechSynthesis;
    // 让其它正在朗读的按钮先让位
    liveSpeakers.forEach((s) => {
      if (s !== handleRef.current) s.stop();
    });
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = LANG;
    utterance.rate = RATE;
    utterance.onend = settle;
    utterance.onerror = settle;
    utteranceRef.current = utterance;
    setSpeaking(true);
    synth.speak(utterance);

    // Chrome 长文本约 15s 后会静默卡住的老问题：定时 pause/resume 续命
    clearTimer();
    timerRef.current = window.setInterval(() => {
      if (!synth.speaking) {
        clearTimer();
        return;
      }
      synth.pause();
      synth.resume();
    }, 10000);
  };

  const halt = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    speaking ? stop() : start();
  };

  return (
    <button
      type="button"
      data-speak-button
      data-speaking={speaking ? 'true' : 'false'}
      aria-label={speaking ? `停止朗读${label}` : `朗读${label}`}
      aria-pressed={speaking}
      onClick={halt}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex shrink-0 select-none items-center gap-1 rounded-full border font-medium transition-colors',
        size === 'md' ? 'h-9 px-3 text-sm' : 'h-7 px-2.5 text-xs',
        speaking
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      {speaking ? (
        <>
          <Square className={cn('h-3 w-3 animate-pulse', size === 'md' && 'h-3.5 w-3.5')} aria-hidden />
          停止
        </>
      ) : (
        <>
          <Volume2 className={cn('h-3 w-3', size === 'md' && 'h-3.5 w-3.5')} aria-hidden />
          朗读
        </>
      )}
    </button>
  );
}

export default SpeakButton;
