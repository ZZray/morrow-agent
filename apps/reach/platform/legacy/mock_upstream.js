// mock upstream：OpenAI 兼容 SSE，用于验证 handwave 流式链路。
// 行为：第一轮返回文本流 + 一次 exec 工具调用；收到 tool 结果后返回带代码块的总结。
const http = require('http');

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const msgs = parsed.messages || [];
    const hasToolResult = msgs.some((m) => m.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = (d) => sse(res, { choices: [{ delta: d }] });
    if (!hasToolResult && parsed.tools) {
      // 先流一段文本，再发起工具调用
      const text = '我来看看远程主机的状态。\n\n';
      for (const ch of text) delta({ content: ch });
      delta({ tool_calls: [{ index: 0, id: 'call_mock1', type: 'function' }] });
      delta({ tool_calls: [{ index: 0, function: { name: 'exec' } }] });
      const args = JSON.stringify({ cmd: 'echo hello-from-mock && ver' });
      for (let i = 0; i < args.length; i += 8)
        delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 8) } }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const md = [
      hasToolResult ? '工具已执行，输出如上卡片所示。\n\n' : '',
      '**总结**：流式与工具闭环正常。\n\n',
      '```bash\necho "代码块渲染"\n```\n\n',
      '- 列表项一\n- 列表项二\n',
    ].join('');
    for (let i = 0; i < md.length; i += 6) delta({ content: md.slice(i, i + 6) });
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen(8801, () => console.log('mock upstream :8801'));
