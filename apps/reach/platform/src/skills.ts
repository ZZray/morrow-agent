// Copyright (c) Ray Zhang. Reach 对话技能：用户自己写的 Markdown 指令，按条消息显式选择后随该任务的目标一起交给 Agent。
// 语义、上限与提示格式沿用 HandWave（apps/handwave/skills.go）：技能不自动执行脚本，也不扩大任何权限。
// 存储为每个用户一个目录、每个技能一个 JSON 文件；写入先写临时文件再改名，读时校验字段。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireCondition, ReachError } from '../../src/service/errors.ts';

export const MAX_SKILL_NAME = 128, MAX_SKILL_DESCRIPTION = 1024, MAX_SKILL_CONTENT = 64 * 1024;
export const MAX_SELECTED_SKILLS = 8, MAX_SELECTED_CONTENT = 128 * 1024, MAX_SKILLS = 200;
export interface SkillMeta { id: string; name: string; description: string; updatedAt: number }
export interface Skill extends SkillMeta { content: string }
export interface SkillInput { name: string; description: string; content: string }
const ID = /^[0-9a-f]{32}$/;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

function validate(input: SkillInput): SkillInput {
  const name = input.name.trim(), description = input.description.trim(), content = input.content.trim();
  requireCondition(name && content, 400, 'skill_invalid', '技能需要名称和内容');
  requireCondition(name.length <= MAX_SKILL_NAME && description.length <= MAX_SKILL_DESCRIPTION && bytes(content) <= MAX_SKILL_CONTENT, 413, 'skill_too_large', `技能过大：名称 ≤ ${MAX_SKILL_NAME} 字，说明 ≤ ${MAX_SKILL_DESCRIPTION} 字，内容 ≤ 64 KB`);
  return { name, description, content };
}

export class SkillStore {
  readonly root: string;
  constructor(stateDirectory: string) { this.root = join(stateDirectory, 'skills'); }
  // 用户 ID 不直接当目录名：取哈希，避免路径字符问题。
  private dir(userId: string) { return join(this.root, createHash('sha256').update(userId).digest('hex').slice(0, 32)); }
  private file(userId: string, id: string) { requireCondition(ID.test(id), 404, 'skill_missing', '技能不存在'); return join(this.dir(userId), `${id}.json`); }
  private read(path: string): Skill | null {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof value?.id !== 'string' || !ID.test(value.id) || typeof value.name !== 'string' || typeof value.description !== 'string' || typeof value.content !== 'string') return null;
      return { id: value.id, name: value.name, description: value.description, content: value.content, updatedAt: Number(value.updatedAt) || 0 };
    } catch { return null; }
  }
  private write(userId: string, skill: Skill) {
    const dir = this.dir(userId); mkdirSync(dir, { recursive: true });
    const path = join(dir, `${skill.id}.json`), temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temp, JSON.stringify(skill) + '\n'); renameSync(temp, path);
  }
  list(userId: string): SkillMeta[] {
    const dir = this.dir(userId); if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => this.read(join(dir, name))).filter((skill): skill is Skill => !!skill)
      .map(({ id, name, description, updatedAt }) => ({ id, name, description, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }
  get(userId: string, id: string): Skill {
    const skill = this.read(this.file(userId, id)); requireCondition(skill && skill.id === id, 404, 'skill_missing', '技能不存在'); return skill;
  }
  create(userId: string, input: SkillInput): Skill {
    const clean = validate(input);
    requireCondition(this.list(userId).length < MAX_SKILLS, 413, 'skill_limit', `最多 ${MAX_SKILLS} 个技能`);
    const skill: Skill = { id: randomBytes(16).toString('hex'), ...clean, updatedAt: Date.now() };
    this.write(userId, skill); return skill;
  }
  update(userId: string, id: string, input: SkillInput): Skill {
    this.get(userId, id); const skill: Skill = { id, ...validate(input), updatedAt: Date.now() };
    this.write(userId, skill); return skill;
  }
  remove(userId: string, id: string) { const path = this.file(userId, id); requireCondition(existsSync(path), 404, 'skill_missing', '技能不存在'); rmSync(path); }
  // 发送时把所选技能固定为快照：之后再改技能不影响已发出的消息。
  resolve(userId: string, ids: string[]): Skill[] {
    requireCondition(ids.length <= MAX_SELECTED_SKILLS && new Set(ids).size === ids.length, 400, 'skill_selection_invalid', `每条消息最多选 ${MAX_SELECTED_SKILLS} 个不重复的技能`);
    const skills = ids.map(id => this.get(userId, id));
    requireCondition(skills.reduce((sum, skill) => sum + bytes(skill.content), 0) <= MAX_SELECTED_CONTENT, 413, 'skill_selection_too_large', '所选技能内容合计超过 128 KB');
    return skills;
  }
}

// 与 HandWave skillPrompt 同口径：明确标注是用户为本条消息选择的指令，不代表执行脚本或额外权限。
export function skillPrompt(skills: Skill[]): string {
  if (!skills.length) return '';
  let text = '\n\n## 用户为本条消息明确选择的技能\n以下是用户选择的 Markdown 指令，仅用于当前请求及其工具续接，不代表自动执行脚本或额外授权。\n';
  for (const skill of skills) text += `\n### 技能 ${skill.name}（${skill.id}）\n${skill.description}\n\n${skill.content}\n`;
  return text;
}

function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end = Math.max(0, end - Math.max(1, Math.floor((Buffer.byteLength(text.slice(0, end), 'utf8') - maxBytes) / 3)));
  return text.slice(0, end).trim();
}

export function parseSkillDraft(raw: unknown): SkillInput | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^```(?:json)?\s*\r?\n?/i, '').replace(/\r?\n?```\s*$/i, '').trim();
  if (!trimmed) return null;
  let parsed: any;
  try { parsed = JSON.parse(trimmed); } catch {
    const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { parsed = JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const name = typeof parsed.name === 'string' ? parsed.name.trim().slice(0, MAX_SKILL_NAME) : '';
  const description = typeof parsed.description === 'string' ? parsed.description.trim().slice(0, MAX_SKILL_DESCRIPTION) : '';
  const content = typeof parsed.content === 'string' ? clipUtf8(parsed.content.trim(), MAX_SKILL_CONTENT) : '';
  if (!name || !content) return null;
  return { name, description, content };
}

export async function generateSkillDraft(endpoint: string, model: string, token: string, prompt: string, signal: AbortSignal): Promise<SkillInput> {
  const cleanPrompt = prompt.trim();
  requireCondition(cleanPrompt, 400, 'skill_prompt_empty', '先描述想创建的技能');
  const system = [
    '你帮用户把工作流程整理成可复用的对话技能（Markdown 指令）。',
    '只输出严格合法的单个 JSON 对象，不要包含任何额外解释，格式为：',
    '{"name":"简短中文或英文短横线名称","description":"一句话适用场景说明","content":"# 目标\\n...\\n# 步骤\\n..."}',
    '技能是交给 AI 助手遵循的 Markdown 指引，不得声称会自动执行隐藏脚本或绕过权限审批。',
  ].join('\n');
  let response: Response;
  try {
    response = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: cleanPrompt }], max_tokens: 2048, temperature: 0.3, stream: false }),
    });
  } catch (error) {
    throw new ReachError(502, 'skill_generate_failed', error instanceof Error && error.name === 'TimeoutError' ? 'AI 生成技能草稿超时，请稍后重试' : '无法连接当前对话模型生成技能');
  }
  if (!response.ok) throw new ReachError(502, 'skill_generate_failed', `模型返回 HTTP ${response.status}，未能生成技能草稿`);
  const data = await response.json() as { choices?: { message?: { content?: unknown } }[] };
  const draft = parseSkillDraft(data.choices?.[0]?.message?.content);
  if (!draft) throw new ReachError(502, 'skill_generate_invalid', '模型未返回可识别的技能草稿结构，请换个描述重试');
  return draft;
}
