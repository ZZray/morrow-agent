"""Ray Zhang: controlled large structured error, through the ordinary desktop Host."""
import json
import os
import sys

for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request.get('method')
    if method == 'initialize':
        result = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'reach-error-fixture', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'Screenshot', 'inputSchema': {'type': 'object', 'properties': {}}}]}
    elif method == 'tools/call':
        with open(os.path.join(os.path.dirname(os.path.dirname(__file__)), 'calls.log'), 'a', encoding='utf-8') as log:
            log.write(str(request['id']) + '\n')
        if request.get('params', {}).get('arguments', {}).get('mode') == 'labels':
            body = '诊断\nReach UI Labels: ' + json.dumps([{'name': 'x' * 1_100_000}], separators=(',', ':'))
            result = {'isError': True, 'content': [{'type': 'text', 'text': body}]}
        else:
            result = {'isError': True, 'structuredContent': {'message': '结构😀\r\n' * 90000}}
    else:
        result = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}, ensure_ascii=False), flush=True)
