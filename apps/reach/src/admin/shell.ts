// Copyright (c) Ray Zhang. Reach 顶部导航的唯一定义。对话是 Reach 的默认页面，与设备、操作同属一套前端。
export interface ConsoleSection { id: 'devices' | 'operations' | 'stats' | 'desk' | 'downloads' | 'mcp' | 'settings'; label: string; href: string }
export const consoleSections: readonly ConsoleSection[] = [
  { id: 'devices', label: '设备', href: '#/devices' },
  { id: 'operations', label: '操作', href: '#/operations' },
  { id: 'desk', label: '对话', href: '#/desk' },
  { id: 'stats', label: '统计', href: '#/stats' },
  { id: 'downloads', label: '下载', href: '#/downloads' },
  { id: 'mcp', label: 'MCP 接入', href: '#/mcp' },
  { id: 'settings', label: '设置', href: '#/settings' },
];
