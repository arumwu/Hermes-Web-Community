"""Smoke only the offline fixture; no environment-overridable production host."""
import asyncio
import argparse
import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import websockets

BASE = 'http://127.0.0.1:18742'


def http(path, body=None):
    req = Request(BASE+path, data=json.dumps(body).encode() if body is not None else None,
                  headers={'Content-Type': 'application/json'})
    with urlopen(req) as response:
        return json.load(response)


async def main():
    http('/__fixture/control', {'action': 'reset', 'auto_complete': False})
    assert len(http('/mobile/api/sessions?limit=100')['sessions']) == 70
    default_rows = http('/mobile/api/sessions?limit=100&profile=default')['sessions']
    assert len(default_rows) == 70 and all(row['profile'] == 'default' for row in default_rows)
    assert all(row['profile'] == 'demo' for row in http('/mobile/api/sessions?limit=100&profile=demo')['sessions'])
    assert len(http('/mobile/api/sessions/default-fixture-1/messages?limit=100&profile=default')['messages']) == 90
    try:
        http('/mobile/api/sessions/fixture-1/messages?profile=default')
        raise AssertionError('Cross-profile HTTP access was accepted')
    except HTTPError as error:
        assert error.code == 404
    assert len(http('/mobile/api/model/options')['providers'][0]['models']) == 50
    assert len(http('/mobile/api/sessions/fixture-1/messages?limit=100')['messages']) == 90
    assert len(http('/mobile/api/skills')['skills']) == 80
    async with websockets.connect(BASE.replace('http://', 'ws://') + '/mobile/ws') as ws:
        ready = json.loads(await ws.recv())
        assert ready['params']['type'] == 'gateway.ready'
        serial = 0

        async def rpc(method, params, expect_error=False):
            nonlocal serial
            serial += 1
            await ws.send(json.dumps({'jsonrpc': '2.0', 'id': serial, 'method': method, 'params': params}))
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), 5))
                if frame.get('id') == serial:
                    if expect_error:
                        assert 'error' in frame, frame
                        return frame['error']
                    assert 'error' not in frame, frame
                    return frame['result']

        await rpc('session.resume', {'session_id': 'fixture-1', 'profile': 'default'}, expect_error=True)
        other = await rpc('session.resume', {'session_id': 'default-fixture-1', 'profile': 'default'})
        assert other['stored_session_id'] == 'default-fixture-1'
        session = await rpc('session.resume', {'session_id': 'fixture-1'})
        sid = session['session_id']
        await rpc('config.set', {'session_id': sid, 'key': 'model', 'value': 'fixture-model-075 --provider fixture-b --session'})
        assert (await rpc('session.resume', {'session_id': sid}))['info']['model'] == 'fixture-model-075'
        params = {'session_id': sid, 'text': '工程測試送出', 'client_submission_id': 'smoke-1'}
        await rpc('prompt.submit', params)
        await rpc('prompt.submit', params)
        assert (await rpc('session.status', {'session_id': sid}))['running']
        assert len(http('/mobile/api/sessions/fixture-1/messages?limit=100')['messages']) == 91
        http('/__fixture/control', {'action': 'approval', 'count': 2})
        resumed = await rpc('session.resume', {'session_id': sid})
        assert len(resumed['open_requests']) == 2
        await ws.send(json.dumps({'jsonrpc': '2.0', 'id': resumed['open_requests'][0]['id'], 'result': {'choice': 'deny'}}))
        assert len((await rpc('session.resume', {'session_id': sid}))['open_requests']) == 1
        http('/__fixture/control', {'action': 'complete'})
        assert not (await rpc('session.status', {'session_id': sid}))['running']
        assert len(http('/mobile/api/sessions/fixture-1/messages?limit=100')['messages']) == 92
    assert len(http('/mobile/api/sessions/default-fixture-1/messages?limit=100&profile=default')['messages']) == 90
    counts = http('/__fixture/state')['counts']
    assert counts['config.set'] == 1 and counts['prompt.submit'] == 2
    http('/__fixture/control', {'action': 'reset'})
    print('PASS: offline HTTP datasets, model readback, running state, submission deduplication, approval recovery, completion, counters, HTTP/RPC profile isolation')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18742)
    port = parser.parse_args().port
    assert 1024 <= port <= 65535
    BASE = f'http://127.0.0.1:{port}'
    asyncio.run(main())
