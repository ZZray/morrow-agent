// Copyright (c) Ray Zhang. 对话续写建议（参照 Ray 工作台为 HandWave 做的 next-suggestion）：回答结束后，用当前对话模型
// 给出「用户下一句最可能想发的话」，前端作为输入框灰字提示，Tab 采纳。只是建议，不会自动发送；失败时安静地不给建议。
export interface SuggestionTurn { content: string; output: string }
export const SUGGESTION_MAX = 80;
const clip = (text: string, size: number) => text.length > size ? text.slice(0, size) + '…' : text;

export function suggestionMessages(turns: SuggestionTurn[]) {
  const recent = turns.slice(-3);
  const history = recent.map((turn, i) => `【第 ${i + 1} 轮】\n用户：${clip(turn.content, 600)}\nReach：${clip(turn.output, 1500)}`).join('\n\n');
  return [
    { role: 'system', content: '你帮用户预测他在这段对话里下一句最可能想发的话。只输出这一句话本身：中文，不超过 40 个字，不加引号、编号或解释。如果没有明确的下一步，只输出「无」。' },
    { role: 'user', content: history },
  ];
}

// 只接受单行、不过长、不是「无」的建议；其余一律当作没有建议。
export function cleanSuggestion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const line = raw.trim().split(/\r?\n/)[0].trim().replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
  if (!line || line === '无' || /^无[。.!！]?$/.test(line) || line.length > SUGGESTION_MAX) return null;
  return line;
}

export async function requestSuggestion(endpoint: string, model: string, token: string, turns: SuggestionTurn[], signal: AbortSignal): Promise<string | null> {
  if (!turns.length) return null;
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages: suggestionMessages(turns), max_tokens: 80, temperature: 0.3, stream: false }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    return cleanSuggestion(data.choices?.[0]?.message?.content);
  } catch { return null; }
}
