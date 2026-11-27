// Copyright (c) Ray Zhang. Reach 默认带云端对话：启动时组合对话运行时（Reach Desk Host）。
// 运行组件 morrow-agent-jsonl 取自 REACH_DESK_SIDECAR 或 PATH；找不到时服务照常启动，设置页与对话页如实说明缺什么。
// Desk Host 代码（platform/ 及 Morrow 客户端模块）按需动态加载：发行包缺这部分时同样照常启动并说明原因，不能让基础服务起不来。
// 模型配置以网页设置为准；REACH_DESK_ENDPOINT/MODEL/MODEL_TOKEN 只在首次启动时导入。
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import type { DeskExtension } from './desk-extension.ts';
import type { ModelConfig } from './model-settings.ts';

export interface DeskComposition { environment?: ModelConfig; create(model: ModelConfig): DeskExtension }
export const SIDECAR_NAME = 'morrow-agent-jsonl';

function isFile(path: string) { try { return statSync(path).isFile(); } catch { return false; } }

// 先看显式配置，再在 PATH 里找；返回绝对路径，或说明为什么不可用。
export function locateSidecar(env: NodeJS.ProcessEnv, platform = process.platform): { path: string } | { unavailable: string } {
  const configured = env.REACH_DESK_SIDECAR;
  if (configured) {
    if (!isAbsolute(configured)) return { unavailable: 'REACH_DESK_SIDECAR 必须是对话运行组件的绝对路径。' };
    return isFile(configured) ? { path: configured } : { unavailable: `REACH_DESK_SIDECAR 指向的对话运行组件不存在：${configured}` };
  }
  const names = platform === 'win32' ? [`${SIDECAR_NAME}.exe`] : [SIDECAR_NAME];
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    if (!isAbsolute(directory)) continue;
    for (const name of names) { const candidate = join(directory, name); if (isFile(candidate)) return { path: candidate }; }
  }
  return { unavailable: `找不到对话运行组件 ${SIDECAR_NAME}。把它放进 PATH，或用 REACH_DESK_SIDECAR 指定绝对路径后重启服务。` };
}

type DeskHostClass = typeof import('../../platform/src/host.ts').DeskHost;
// 测试可注入加载函数，模拟发行包缺少 Desk 代码的情况。
export async function prepareDesk(env: NodeJS.ProcessEnv, dataDirectory: string, load: () => Promise<{ DeskHost: DeskHostClass }> = () => import('../../platform/src/host.ts')): Promise<{ composition?: DeskComposition; unavailable?: string }> {
  // 环境里的模型令牌只读一次并移除，与是否找到运行组件无关。
  const fields = [env.REACH_DESK_ENDPOINT, env.REACH_DESK_MODEL, env.REACH_DESK_MODEL_TOKEN];
  delete env.REACH_DESK_MODEL_TOKEN;
  if (fields.some(Boolean) && !fields.every(Boolean)) throw Error('REACH_DESK_ENDPOINT, REACH_DESK_MODEL and REACH_DESK_MODEL_TOKEN must be set together');
  const environment = fields.every(Boolean) ? { endpoint: fields[0]!, model: fields[1]!, token: fields[2]! } : undefined;
  const sidecar = locateSidecar(env);
  if ('unavailable' in sidecar) return { unavailable: sidecar.unavailable };
  let DeskHost: DeskHostClass;
  try { ({ DeskHost } = await load()); }
  catch (error) { return { unavailable: `发行包缺少对话运行时代码（platform/ 或 Morrow 客户端模块），无法加载：${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}` }; }
  const stateDirectory = resolve(env.REACH_DESK_STATE_DIR ?? join(dataDirectory, 'desk'));
  // REACH_MODEL_LOOPBACK=1：允许使用服务器本机回环地址的模型端点（如 OMP 网关），流量不出本机。
  const developmentLoopback = env.REACH_DESK_LOOPBACK_RELAY === '1' || env.REACH_MODEL_LOOPBACK === '1';
  return {
    composition: {
      environment,
      create: model => {
        if (!existsSync(stateDirectory)) mkdirSync(stateDirectory, { recursive: true });
        const capabilities = model.contextWindow !== undefined ? { contextWindow: model.contextWindow, maxTokens: model.maxOutput!, imageInput: !!model.imageInput } : undefined;
        return new DeskHost({ stateDirectory, binary: sidecar.path, endpoint: model.endpoint, model: model.model, modelToken: model.token, capabilities, developmentLoopback });
      },
    },
  };
}
