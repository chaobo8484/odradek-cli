export function estimateTokenCount(text: string): number {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 0;
  }

  const cjkMatches = normalized.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = Math.max(0, normalized.length - cjkCount);
  const estimated = Math.ceil(cjkCount + otherCount / 4);
  return Math.max(1, estimated);
}
