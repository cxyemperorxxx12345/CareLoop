// 保留短词，并覆盖中文整句中的重叠词；只输出汉字/字母/数字，避免拼接过滤器语法。
export function extractKnowledgeKeywords(question: string): string[] {
  const chunks = question.slice(0, 256).match(/[\u4e00-\u9fa5]+|[A-Za-z0-9]+/g) ?? [];
  const words = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.length < 2) continue;
    if (chunk.length <= 4 || /^[A-Za-z0-9]+$/.test(chunk)) words.add(chunk);
    if (/^[\u4e00-\u9fa5]+$/.test(chunk)) {
      for (let size = 2; size <= 3; size++) {
        for (let i = 0; i + size <= chunk.length; i++) words.add(chunk.slice(i, i + size));
      }
    }
  }
  return [...words].slice(0, 32);
}
