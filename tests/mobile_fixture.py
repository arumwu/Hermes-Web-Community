"""Offline mobile UI fixture; never imports server.py or connects to any Gateway.

Run: uv run --with fastapi --with uvicorn --with websockets uvicorn mobile_fixture:app
     --app-dir tests --host 127.0.0.1 --port 18742
GET /__fixture/state: counters, sessions, pending requests and settings.
POST /__fixture/control: {action: reset|running|complete|approval|clarify|disconnect,
                         session_id: fixture-1, count: 2, auto_complete: false}
All writes affect this process's memory only. Restart or reset discards them.
"""
import asyncio
import base64
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
assets = Path(__file__).resolve().parents[1] / 'build/web'
ROOT = '/fixture/workspace'
clients = set()
state = {}


def reset():
    now = datetime.now(timezone.utc)
    state.clear()
    state.update(counts=Counter(), calls=[], sessions={}, messages={}, pending=[],
                 running=set(), deliveries={}, auto_complete=True, revision=1,
                 projects=[{'name': f'工程測試專案 {i}', 'primary_path': f'{ROOT}/project-{i}'} for i in range(1, 5)],
                 settings={'timezone': 'Asia/Taipei', 'model': {'default': 'fixture-model-001', 'provider': 'fixture-a'},
                           'agent': {'personality': '工程假資料', 'reasoning_effort': 'medium'},
                           'display': {'show_reasoning': True}, 'approvals': {'mode': 'ask', 'timeout': 120},
                           'memory': {'memory_enabled': True}, 'compression': {'enabled': True}, 'stt': {}, 'tts': {}},
                 documents={'memory': '# 工程測試記憶\n這是假資料。', 'soul': '# 工程測試心智\n僅限本機驗證。'},
                 files={}, jobs=[], inventory={})
    for i in range(1, 76):
        sid = f'fixture-{i}'
        state['sessions'][sid] = dict(id=sid, profile='demo', title='日常助理' if i == 1 else f'工程對話 {i}：手機版長中文標題與操作測試',
            preview='工程假資料：長摘要用來檢查省略、行距及手機閱讀。', model='fixture-model-001', provider='fixture-a',
            workspacePath=f'{ROOT}/project-{i % 4 + 1}', cwd=f'{ROOT}/project-{i % 4 + 1}',
            updated_at=(now-timedelta(days=i // 5)).isoformat(), pinned=i == 2, archived=i > 70,
            source='cron' if i % 8 == 0 else 'mobile-web', unread=i % 3 == 0, reasoning_effort='medium')
        state['messages'][sid] = [{'id': f'{sid}-m{j}', 'role': 'assistant' if j % 2 else 'user',
            'content': f'工程訊息 {j}\n\n' + ('這是多段中文長訊息，供回看捲動與文字換行測試。\n\n' * (12 if j % 7 == 0 else 1)),
            'timestamp': now.isoformat()} for j in range(90 if i == 1 else 6)]
    for sid, row in list(state['sessions'].items()):
        other = f'default-{sid}'
        state['sessions'][other] = {**row, 'id': other, 'profile': 'default', 'title': f'Default · {row["title"]}'}
        state['messages'][other] = [{**message, 'id': f'default-{message["id"]}', 'content': f'Default 獨立對話\n{message["content"]}'} for message in state['messages'][sid]]
    for root in [ROOT] + [p['primary_path'] for p in state['projects']]:
        for name in ['README.md', '資料夾/子目錄/手機操作測試（繁體中文）.txt', '.hidden.txt', '資料夾/說明.md']:
            state['files'][f'{root}/{name}'] = 'data:text/plain;base64,' + base64.b64encode(f'# 工程假資料\n{root}/{name}\n本檔可編輯，僅存在記憶體。'.encode()).decode()
    state['jobs'] = [dict(id=f'job-{i}', name=f'工程定時任務 {i}', schedule='0 9 * * *', prompt='工程假資料，不會執行外部工作',
        enabled=i % 3 != 0, next_run_at=(now+timedelta(hours=i)).isoformat(), last_run_at=now.isoformat(), last_status='success') for i in range(1, 13)]
    state['inventory'] = {kind: [dict(name=f'fixture-{kind}-{i}', description=f'工程假能力 {i}', enabled=i % 3 != 0) for i in range(1, 81 if kind == 'skills' else 5)] for kind in ['skills', 'toolsets', 'mcp']}


reset()


def record(name, params=None):
    state['counts'][name] += 1
    state['calls'].append({'method': name, 'params': params or {}})


def stored(runtime):
    return str(runtime).removeprefix('runtime-')


def info(sid):
    row = state['sessions'][sid]
    return {key: row.get(key, '') for key in ['model', 'provider', 'reasoning_effort', 'cwd']}


async def broadcast(frame):
    for ws in list(clients):
        try:
            await ws.send_json(frame)
        except (RuntimeError, WebSocketDisconnect):
            clients.discard(ws)


async def event(sid, kind, payload=None):
    await broadcast({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': kind, 'session_id': f'runtime-{sid}', 'payload': {'profile': state['sessions'][sid]['profile'], **(payload or {})}}})


async def complete(sid):
    if sid not in state['running']:
        return
    state['running'].discard(sid)
    text = '工程測試回覆完成。這是假串流，沒有呼叫模型或外部服務。'
    state['messages'][sid].append({'role': 'assistant', 'content': text})
    await event(sid, 'message.complete', {'text': text, 'status': 'success'})


async def stream(sid):
    await asyncio.sleep(.2)
    for text in ['工程測試：', '正在產生', '假串流回覆。']:
        if sid not in state['running']:
            return
        await event(sid, 'message.delta', {'text': text})
        await asyncio.sleep(.4)
    if state['auto_complete']:
        await asyncio.sleep(1)
        await complete(sid)


@app.get('/__fixture/state')
async def inspect_state():
    return {**state, 'running': sorted(state['running'])}


@app.post('/__fixture/control')
async def control(request: Request):
    body = await request.json()
    action = body.get('action', '')
    sid = stored(body.get('session_id', 'fixture-1'))
    if action == 'reset':
        reset()
    if 'auto_complete' in body:
        state['auto_complete'] = bool(body['auto_complete'])
    if action == 'running':
        state['running'].add(sid)
        await event(sid, 'message.start')
    elif action == 'complete':
        await complete(sid)
    elif action in ('approval', 'clarify'):
        for _ in range(int(body.get('count', 1))):
            rid = f'fixture-request-{state["revision"]}'
            state['revision'] += 1
            params = {'session_id': f'runtime-{sid}', 'profile': state['sessions'][sid]['profile'], 'description': '工程假請求。' * int(body.get('length', 20))}
            if action == 'approval':
                params.update(command='fixture-command --local-only', choices=['once', 'session', 'deny'])
            else:
                params['questions'] = [{'qid': 'question-1', 'question': '工程測試：請選擇處理方式', 'choices': ['方式甲', '方式乙'], 'multi_select': False}]
            frame = {'jsonrpc': '2.0', 'id': rid, 'method': action, 'params': params}
            state['pending'].append(frame)
            await broadcast(frame)
    elif action == 'disconnect':
        for ws in list(clients):
            await ws.close(code=1012)
    return {'ok': True, 'fake': True}


@app.api_route('/mobile/auth/{action}', methods=['GET', 'POST'])
async def auth(action: str):
    return {'authenticated': True, 'csrf': 'offline-fixture-only', 'account_scope': 'offline-mobile-fixture', 'display_name': '工程測試', 'profiles': ['demo', 'default']}


@app.api_route('/mobile/api/{path:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
async def api(path: str, request: Request):
    body = await request.json() if request.method not in ('GET', 'DELETE') else {}
    record(f'{request.method} {path}', body)
    q = request.query_params
    profile = q.get('profile', 'demo')
    if profile not in ('demo', 'default'):
        return JSONResponse({'detail': 'Unknown fixture profile'}, status_code=403)
    if path == 'profiles':
        return {'profiles': [{'name': 'demo', 'display_name': '工程測試 Demo'}, {'name': 'default', 'display_name': '工程測試 Default'}]}
    if path == 'sessions':
        rows = [s for s in state['sessions'].values() if s['profile'] == profile and s.get('archived', False) == (q.get('archived') == 'only')]
        offset, limit = int(q.get('offset', 0)), int(q.get('limit', 60))
        return {'sessions': rows[offset:offset+limit], 'total': len(rows)}
    if path.startswith('sessions/'):
        sid = path.split('/')[1]
        if sid not in state['sessions'] or state['sessions'][sid]['profile'] != profile:
            return JSONResponse({'detail': 'Unknown fixture session'}, status_code=404)
        if path.endswith('/messages'):
            offset, limit = int(q.get('offset', 0)), int(q.get('limit', 60))
            return {'messages': state['messages'][sid][offset:offset+limit]}
        if request.method == 'PATCH':
            state['sessions'][sid].update(body)
        if request.method == 'DELETE':
            del state['sessions'][sid]
            return {'ok': True}
        return {'session': {**state['sessions'][sid], 'message_count': len(state['messages'][sid])}}
    if path == 'config':
        return {'terminal': {'cwd': ROOT}, 'model': state['settings']['model']}
    if path == 'model/options':
        return {'model': 'fixture-model-001', 'provider': 'fixture-a', 'providers': [dict(slug=f'fixture-{name}', name=f'工程模型商 {name.upper()}', authenticated=True,
            models=[f'fixture-model-{i:03}' for i in range(start, start+50)]) for name, start in [('a', 1), ('b', 51)]]}
    if path == 'settings':
        if request.method == 'PUT':
            for key, value in body.get('settings', {}).items():
                if isinstance(value, dict):
                    state['settings'].setdefault(key, {}).update(value)
                else:
                    state['settings'][key] = value
            state['revision'] += 1
        return {'settings': state['settings'], 'revision': str(state['revision'])}
    if path.startswith('profile-documents/'):
        kind = path.split('/')[-1]
        if request.method == 'PUT':
            state['documents'][kind] = body['content']
            state['revision'] += 1
        return {'exists': True, 'content': state['documents'].get(kind, ''), 'revision': str(state['revision']), 'concurrency': True, 'profile': profile}
    if path in state['inventory']:
        return {'servers' if path == 'mcp' else path: state['inventory'][path]}
    if path.startswith('inventory/'):
        if path.endswith('/enabled'):
            for item in state['inventory'][path.split('/')[1]]:
                if item['name'] == body['name']:
                    item['enabled'] = body['enabled']
        return {'ok': True, 'content': '# 工程假技能\n僅供版面測試。'}
    if path == 'today':
        return {'exists': False, 'cards': [], 'workspace': ROOT}
    if path == 'files':
        directory = q.get('path') or ROOT
        entries = {}
        for file, data in state['files'].items():
            if file.startswith(directory.rstrip('/') + '/'):
                relative = file[len(directory.rstrip('/'))+1:]
                name = relative.split('/')[0]
                entries[name] = {'name': name, 'path': directory.rstrip('/') + '/' + name, 'is_directory': '/' in relative, 'size': len(data), 'mime_type': 'text/plain'}
        return {'path': directory, 'parent': str(PurePosixPath(directory).parent) if directory != ROOT else None, 'entries': list(entries.values())}
    if path == 'files/upload':
        state['files'][body['path']] = body['data_url']
        return {'ok': True, 'path': body['path']}
    if path == 'files/read':
        file = q.get('path', '')
        if file not in state['files']:
            return JSONResponse({'detail': 'Unknown fixture file'}, status_code=404)
        return {'path': file, 'name': PurePosixPath(file).name, 'data_url': state['files'][file], 'mime_type': 'text/plain'}
    if path == 'cron/jobs':
        if request.method == 'POST':
            state['jobs'].append({**body, 'id': f'job-{state["revision"]+100}', 'enabled': True})
            state['revision'] += 1
        return {'jobs': state['jobs']}
    if path.startswith('cron/jobs/'):
        parts = path.split('/')
        job = next((j for j in state['jobs'] if j['id'] == parts[2]), None)
        if not job:
            return JSONResponse({'detail': 'Unknown fixture job'}, status_code=404)
        if request.method == 'DELETE':
            state['jobs'].remove(job)
        elif request.method == 'PUT':
            job.update(body)
        elif len(parts) == 4:
            if parts[3] in ('pause', 'resume'):
                job['enabled'] = parts[3] == 'resume'
            else:
                job['last_status'] = 'fixture-triggered'
        return {'job': job}
    if path.startswith('deliveries/'):
        return {'state': 'accepted' if path.split('/')[-1] in state['deliveries'] else 'unknown'}
    return JSONResponse({'detail': f'Unsupported fixture route: {path}'}, status_code=404)


async def rpc(method, p):
    sid = stored(p.get('session_id', 'fixture-1'))
    profile = p.get('profile', 'demo')
    if profile not in ('demo', 'default'):
        raise ValueError('Unknown fixture profile')
    if p.get('session_id') and (sid not in state['sessions'] or state['sessions'][sid]['profile'] != profile):
        raise ValueError('Unknown session in fixture profile')
    if method == 'client.capabilities':
        return {'server_requests': True}
    if method == 'projects.list':
        return {'projects': state['projects']}
    if method == 'commands.catalog':
        return {'commands': [{'name': 'help', 'description': '工程測試說明'}, {'name': 'compact', 'description': '工程整理'}]}
    if method == 'session.create':
        sid = f'fixture-new-{state["revision"]}'
        state['revision'] += 1
        state['sessions'][sid] = dict(id=sid, profile=p.get('profile', 'demo'), title='工程新對話', model='fixture-model-001', provider='fixture-a', cwd=ROOT, reasoning_effort='medium')
        state['messages'][sid] = []
    if method in ('session.create', 'session.resume'):
        return {'session_id': f'runtime-{sid}', 'stored_session_id': sid, 'info': info(sid), 'running': sid in state['running'], 'open_requests': [r for r in state['pending'] if r['params']['session_id'] == f'runtime-{sid}']}
    if method == 'session.events.since':
        return {'events': [], 'open_requests': [r for r in state['pending'] if r['params']['session_id'] == f'runtime-{sid}']}
    if method == 'session.status':
        return {'running': sid in state['running'], 'output': f'Agent Running: {"Yes" if sid in state["running"] else "No"}'}
    if method == 'session.active_list':
        return {'sessions': [{'stored_session_id': s, 'session_id': f'runtime-{s}', 'profile': state['sessions'][s]['profile'], 'title': state['sessions'][s]['title']} for s in state['running'] if state['sessions'][s]['profile'] == profile], 'scope_complete': True}
    if method == 'session.cwd.set':
        state['sessions'][sid]['cwd'] = p['cwd']
        return {'cwd': p['cwd']}
    if method == 'config.get':
        return {'value': state['sessions'][sid].get('reasoning_effort', 'medium')}
    if method == 'config.set':
        await asyncio.sleep(.25)
        if p['key'] == 'model':
            parts = p['value'].split()
            state['sessions'][sid].update(model=parts[0], provider=parts[parts.index('--provider')+1])
        else:
            state['sessions'][sid]['reasoning_effort'] = p['value']
        return {'scope': 'session', 'ok': True}
    if method == 'prompt.submit':
        delivery = p.get('client_submission_id')
        if delivery and delivery in state['deliveries']:
            return {'accepted': True}
        if delivery:
            state['deliveries'][delivery] = sid
        state['messages'][sid].append({'role': 'user', 'content': p.get('text', '')})
        state['running'].add(sid)
        await event(sid, 'message.start')
        asyncio.create_task(stream(sid))
        return {'accepted': True}
    if method == 'session.steer':
        if sid not in state['running']:
            raise ValueError('Fixture session is not running')
        state['messages'][sid].append({'role': 'user', 'content': p.get('text', '')})
        return {'ok': True, 'accepted': True}
    if method == 'complete.slash':
        return {'commands': ['/help', '/compact']}
    if method == 'slash.exec':
        return {'ok': True, 'output': '工程假指令已接收'}
    if method == 'session.interrupt':
        await complete(sid)
        return {'ok': True}
    if method in ('clarify.lock', 'approval.respond', 'clarify.respond'):
        rid = p.get('request_id')
        state['pending'] = [r for r in state['pending'] if r['id'] != rid]
        return {'status': 'ok'}
    if method == 'image.attach_bytes':
        return {'ok': True}
    raise ValueError(f'Unsupported fixture RPC: {method}')


@app.websocket('/mobile/ws')
async def socket(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    await ws.send_json({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'gateway.ready'}})
    try:
        while True:
            frame = await ws.receive_json()
            method = frame.get('method')
            if not method:
                record('server-response', frame)
                state['pending'] = [r for r in state['pending'] if r['id'] != frame.get('id')]
                continue
            record(method, frame.get('params'))
            try:
                result = await rpc(method, frame.get('params', {}))
                await ws.send_json({'jsonrpc': '2.0', 'id': frame.get('id'), 'result': result})
            except (ValueError, KeyError) as error:
                await ws.send_json({'jsonrpc': '2.0', 'id': frame.get('id'), 'error': {'code': -32601, 'message': str(error)}})
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


@app.get('/mobile/{asset:path}')
async def static(asset: str):
    asset = asset or 'index.html'
    path = assets / asset
    if not path.resolve().is_relative_to(assets.resolve()) or not path.is_file():
        return JSONResponse({'detail': 'Fixture asset not found'}, status_code=404)
    headers = {'Cache-Control': 'no-store'}
    if asset == 'index.html':
        return HTMLResponse(path.read_text().replace('<title>', '<title>工程假資料測試 · ', 1), headers=headers)
    return FileResponse(path, headers=headers)
