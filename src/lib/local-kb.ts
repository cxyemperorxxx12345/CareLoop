import { extractKnowledgeKeywords } from '../../supabase/functions/_shared/knowledge-keywords';
// 本地知识库兜底：当 AI 助手（assistant-chat / MiniMax）连不上或没有回答时，
// 降级从 knowledge_docs 表做关键词检索，明确标注「非 AI 回答」。
// knowledge_docs 的 RLS 允许所有登录用户 SELECT（患者可读），因此纯前端即可，无需迁移。
import { supabase } from '@/db/supabase';

// 单条命中结果
export type LocalKbHit = {
  id: string;
  title: string;
  category: string;
  snippet: string;
};

// 从问题中提取关键词（≥2 字）用于本地模糊检索。
// 中文整句通常没有空格：若把整句当一个关键词去子串匹配永远命中不了，
// 因此先取标点/空格分隔出的词，再对中文长串生成「重叠」2~3 字窗口
// （bigram 最易命中知识库，如「术后伤口怎么护理」→ 术后/伤口/护理）。
// 不区分大小写的子串出现次数
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = h.indexOf(n, from);
    if (idx === -1) break;
    count++;
    from = idx + n.length;
  }
  return count;
}

// 本地知识库检索：纯前端、只读、失败返回 []（表缺失或网络异常均不阻断主流程）。
export async function searchLocalKnowledge(question: string): Promise<LocalKbHit[]> {
  try {
    const keywords = extractKnowledgeKeywords(question);
    if (keywords.length === 0) return [];

    const { data, error } = await supabase
      .from('knowledge_docs')
      .select('id, title, category, content')
      .limit(100);
    if (error) return [];
    const docs = (data ?? []) as Array<{ id: string; title: string; category: string; content: string }>;
    if (docs.length === 0) return [];

    const scored = docs
      .map((doc) => {
        let score = 0;
        for (const kw of keywords) {
          score += countOccurrences(doc.title, kw) * 2;
          score += countOccurrences(doc.content, kw);
        }
        return { doc, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (scored.length === 0) return [];

    return scored.map(({ doc }) => {
      const plain = (doc.content ?? '').replace(/\s+/g, ' ').trim();
      const snippet = plain.length > 120 ? `${plain.slice(0, 120)}…` : plain;
      return {
        id: doc.id,
        title: doc.title ?? '',
        category: doc.category ?? '',
        snippet,
      };
    });
  } catch {
    return [];
  }
}
