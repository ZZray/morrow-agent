// Copyright (c) Ray Zhang. 对话使用的 Morrow 环境目录（知识库、Agent 建的技能、环境工具）。
// 新对话按用户共享，让记忆跨对话延续（用户 2026-11-26 决定「Share per user」）；
// 已有对话（目录里已有 session.json 或 environment）继续用原来的独立目录：运行声明里含环境路径，换路径会让续接与结算的声明不一致。
// 首次的选择写进对话目录的 environment-path.txt，之后每次都读它，同一对话的路径不会变。
// 并发：Morrow 对知识库与技能库写入加独占文件锁，冲突时那次工具调用返回「busy; retry later」，不会写坏数据。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function sharedEnvironment(stateDirectory: string, userId: string) {
  return join(stateDirectory, 'users', createHash('sha256').update(userId).digest('hex').slice(0, 32), 'environment');
}

export function chooseEnvironment(conversationDirectory: string, shared: string) {
  const choice = join(conversationDirectory, 'environment-path.txt');
  if (existsSync(choice)) { const recorded = readFileSync(choice, 'utf8').trim(); if (recorded) return recorded; }
  const legacy = existsSync(join(conversationDirectory, 'session.json')) || existsSync(join(conversationDirectory, 'environment'));
  const path = legacy ? join(conversationDirectory, 'environment') : shared;
  mkdirSync(path, { recursive: true }); mkdirSync(conversationDirectory, { recursive: true });
  writeFileSync(choice, path + '\n');
  return path;
}
