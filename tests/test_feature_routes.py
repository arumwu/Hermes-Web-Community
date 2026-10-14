"""Author QA against a fake native backend. No network, live accounts or models."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import httpx

os.environ['HERMES_MOBILE_DEV'] = '1'
os.environ['HERMES_MOBILE_ORIGIN'] = 'http://127.0.0.1:9180'
os.environ['HERMES_MOBILE_ADMIN'] = 'fixture-admin'
os.environ['HERMES_MOBILE_PROFILES'] = 'default,secondary'
os.environ['HERMES_MOBILE_FILE_ROOT'] = '/srv/hermes'
spec = importlib.util.spec_from_file_location('feature_server', Path(__file__).parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)


def data_url(text, mime='text/markdown'):
    raw = text.encode() if isinstance(text, str) else text
    return 'data:' + mime + ';base64,' + base64.b64encode(raw).decode()


def merge(target, patch):
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            merge(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


class FeatureRoutes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.native_calls = []
        self.files = {}
        self.directory_responses = {}
        self.read_paths = {}
        config = {'model': {'provider': 'native', 'default': 'model-a', 'api_key': 'DUMMY_HIDDEN'},
                  'agent': {'personality': 'helpful', 'reasoning_effort': 'high', 'disabled_toolsets': ['old']},
                  'timezone': 'Asia/Taipei', 'display': {'show_reasoning': True},
                  'approvals': {'mode': 'manual', 'timeout': 60},
                  'stt': {'provider': 'openai', 'enabled': True, 'openai': {'api_key': 'DUMMY_HIDDEN', 'model': 'whisper-1', 'language': 'zh'}},
                  'tts': {'provider': 'edge', 'edge': {'voice': 'zh-TW-HsiaoChenNeural'}},
                  'mcp_servers': {'sample': {'enabled': True, 'command': 'DUMMY_HIDDEN'}},
                  'terminal': {'cwd': '/srv/hermes/workspace'}}
        self.configs = {p: copy.deepcopy(config) for p in server.PROFILES}
        self.skills = {'sample': True}
        self.mcp = {'sample': True}
        self.jobs = {}
        self.backend = httpx.AsyncClient(base_url='http://fake-native', transport=httpx.MockTransport(self.native))
        server.feature_locks.clear()
        server.failures.clear()
        server.sessions['fixture'] = server.Session(self.backend, 'fixture-csrf')
        self.web = httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url='http://mobile',
                                    cookies={server.COOKIE: 'fixture'}, headers={'Origin': server.ORIGIN, 'X-Mobile-CSRF': 'fixture-csrf'})

    async def asyncTearDown(self):
        await self.web.aclose()
        await self.backend.aclose()
        server.sessions.clear()
        server.feature_locks.clear()

    async def native(self, request):
        path, p = request.url.path, request.url.params.get('profile', 'default')
        body = json.loads(request.content) if request.content else None
        self.native_calls.append((request.method, path, p, body))
        if path == '/api/auth/me':
            return httpx.Response(200, json={'authenticated': True})
        if path == '/api/config':
            if request.method == 'PUT':
                merge(self.configs[p], body['config'])
                return httpx.Response(200, json={'ok': True})
            return httpx.Response(200, json=self.configs[p])
        if path == '/api/model/options':
            return httpx.Response(200, json={'providers': [{'slug': 'native', 'models': ['model-a', 'model-b'],
                'api_key': 'DUMMY_HIDDEN', 'capabilities': {'model-a': {'reasoning': True,
                    'can_disable_reasoning': False, 'private_metadata': 'DUMMY_HIDDEN'}}}]})
        if path.startswith('/api/cron/jobs/'):
            return httpx.Response(200, json={'job': self.jobs[path.rsplit('/', 1)[1]]})
        if path == '/api/files/read':
            filename = request.url.params.get('path')
            if filename not in self.files:
                return httpx.Response(404, json={'detail': 'missing'})
            return httpx.Response(200, json={'path': self.read_paths.get(filename, filename), 'data_url': data_url(self.files[filename])})
        if path == '/api/files':
            directory = request.url.params['path']
            if directory in self.directory_responses:
                status, value = self.directory_responses[directory]
                return httpx.Response(status, json=value)
            entries = [{'name': Path(filename).name, 'path': filename, 'is_directory': False}
                       for filename in self.files if str(Path(filename).parent) == directory]
            return httpx.Response(200, json={'path': directory, 'entries': entries})
        if path == '/api/files/upload':
            self.files[body['path']] = base64.b64decode(body['data_url'].split(',', 1)[1]).decode()
            return httpx.Response(200, json={'ok': True, 'path': body['path']})
        if path == '/api/audio/transcribe':
            return httpx.Response(200, json={'ok': True, 'transcript': '你好，這是測試。', 'provider': 'fake', 'api_key': 'DUMMY_HIDDEN'})
        if path == '/api/audio/speak':
            return httpx.Response(200, json={'ok': True, 'data_url': data_url(b'fake-audio', 'audio/wav'), 'mime_type': 'audio/wav', 'provider': 'fake'})
        if path == '/api/skills':
            return httpx.Response(200, json=[{'name': name, 'enabled': enabled} for name, enabled in self.skills.items()])
        if path == '/api/skills/toggle':
            self.skills[body['name']] = body['enabled']
            return httpx.Response(200, json={'ok': True})
        if path == '/api/skills/content':
            return httpx.Response(200, json={'name': 'sample', 'content': 'Fixture instructions', 'path': '/not-for-browser'})
        if path == '/api/tools/toolsets':
            return httpx.Response(200, json=[{'name': 'sample', 'enabled': True}])
        if path == '/api/mcp/servers':
            return httpx.Response(200, json={'servers': [{'name': name, 'enabled': enabled, 'args': ['DUMMY_HIDDEN']} for name, enabled in self.mcp.items()]})
        if path == '/api/mcp/servers/sample/enabled':
            self.mcp['sample'] = body['enabled']
            return httpx.Response(200, json={'ok': True})
        raise AssertionError(f'Unexpected native route {request.method} {path}')

    def board(self):
        return {'schema_version': 1, 'presentation_version': 4, 'date': '2026-10-14',
                'generated_at': '2026-10-14T10:00:00+08:00', 'headline': '測試總覽', 'cards': [
                    {'id': 'decision-a', 'kind': 'decision', 'status': 'open', 'title': '選擇時間', 'summary': '測試',
                     'presentation': {'layout': 'interactive', 'caption': '測試', 'interaction': {'version': 1, 'type': 'clarification',
                                      'items': [{'id': 'one', 'title': '早上'}, {'id': 'two', 'title': '晚上'}]}}}]}

    async def test_today_prepare_is_scoped_read_only_and_preserves_operation_id(self):
        snapshot = (await self.web.get('/mobile/api/today?profile=secondary')).json()
        self.assertEqual(snapshot['revision'], 'missing')
        self.assertEqual(snapshot['shared_workspace_profiles'], ['default'])
        prepared = await self.web.post('/mobile/api/today/prepare?profile=secondary', json={
            'mode': 'refresh_overview_only', 'revision': 'missing', 'operation_id': 'test-operation'})
        self.assertEqual(prepared.status_code, 200, prepared.text)
        result = prepared.json()
        self.assertEqual(result['operation_id'], 'test-operation')
        document = json.loads(base64.b64decode(result['attachments'][0]['data_url'].split(',')[1]))
        self.assertEqual(document['profile'], 'secondary')
        self.assertEqual(document['expected_board_sha256'], 'missing')
        self.assertTrue(all(call[0] == 'GET' for call in self.native_calls))
        self.assertEqual(self.files, {})

    async def test_today_conflicts_and_format_repair_do_not_overwrite(self):
        modern = '/srv/hermes/workspace/.hermes-app/today/hermes-today.json'
        legacy = '/srv/hermes/workspace/hermes-today.json'
        self.files[modern] = '{bad json'
        snapshot = (await self.web.get('/mobile/api/today')).json()
        self.assertTrue(snapshot['format_error'])
        for mode, expected in [('refresh_overview_only', 409), ('repair_format_only', 200)]:
            result = await self.web.post('/mobile/api/today/prepare', json={'revision': snapshot['revision'], 'mode': mode})
            self.assertEqual(result.status_code, expected, result.text)
        self.files[legacy] = 'different'
        conflict = await self.web.get('/mobile/api/today')
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.files[modern], '{bad json')

    async def test_today_action_and_receipt_require_exact_card_and_operation(self):
        filename = '/srv/hermes/workspace/.hermes-app/today/hermes-today.json'
        board = self.board()
        self.files[filename] = json.dumps(board)
        snapshot = (await self.web.get('/mobile/api/today')).json()
        body = {'revision': snapshot['revision'], 'mode': 'apply_card_action', 'card_id': 'decision-a',
                'operation_id': 'action-a', 'input': {'selection': 'one'}}
        good = await self.web.post('/mobile/api/today/prepare', json=body)
        self.assertEqual(good.status_code, 200, good.text)
        body['input']['selection'] = 'untrusted-other-option'
        self.assertEqual((await self.web.post('/mobile/api/today/prepare', json=body)).status_code, 400)
        query = '/mobile/api/today/receipt?mode=apply_card_action&card_id=decision-a&operation_id=action-a'
        self.assertFalse((await self.web.get(query)).json()['confirmed'])
        board['action_receipts'] = [{'operation_id': 'action-a', 'card_id': 'decision-other', 'status': 'applied'}]
        self.files[filename] = json.dumps(board)
        self.assertFalse((await self.web.get(query)).json()['confirmed'])
        board['action_receipts'][0]['card_id'] = 'decision-a'
        self.files[filename] = json.dumps(board)
        self.assertTrue((await self.web.get(query)).json()['confirmed'])
        body['input']['selection'] = 'one'
        self.assertEqual((await self.web.post('/mobile/api/today/prepare', json=body)).status_code, 409)

    async def test_today_schedule_input_must_have_distinct_times_and_real_timezone(self):
        body = {'revision': 'missing', 'mode': 'configure_card_schedule', 'morning': '08:00', 'evening': '08:00', 'timezone': 'Asia/Taipei'}
        self.assertEqual((await self.web.post('/mobile/api/today/prepare', json=body)).status_code, 400)
        body['evening'] = '19:00'
        body['timezone'] = 'Fake/City'
        self.assertEqual((await self.web.post('/mobile/api/today/prepare', json=body)).status_code, 400)
        body['timezone'] = 'Asia/Taipei'
        self.assertEqual((await self.web.post('/mobile/api/today/prepare', json=body)).status_code, 200)

    async def test_today_schedule_receipt_requires_native_times_timezone_and_next_run(self):
        board = self.board()
        workspace = '/srv/hermes/workspace'
        marker = 'hermes-app-today:' + server.hashlib.sha256(('default\n'+workspace).encode()).hexdigest()[:20]
        board['refresh_receipts'] = [{'request_id': 'schedule-op', 'status': 'applied'}]
        board['schedule_receipt'] = {'operation_id': 'schedule-op', 'schedule_marker': marker, 'job_ids': ['morning-a', 'evening-a'],
                                     'morning': '08:30', 'evening': '19:00', 'timezone': 'Asia/Taipei'}
        self.files[workspace+'/.hermes-app/today/hermes-today.json'] = json.dumps(board)
        for period, when, expression in [('morning', '08:30', '30 8 * * *'), ('evening', '19:00', '0 19 * * *')]:
            self.jobs[period+'-a'] = {'id': period+'-a', 'paused': False, 'prompt': marker+' '+workspace+' .hermes-app/today/ '+period,
                                    'schedule': {'kind': 'cron', 'expr': expression}, 'next_run_at': '2030-10-15T'+when+':00+08:00'}
        route = '/mobile/api/today/receipt?operation_id=schedule-op&mode=configure_card_schedule'
        result = await self.web.get(route)
        self.assertTrue(result.json()['confirmed'], result.text)
        self.jobs['morning-a']['schedule']['expr'] = '30 9 * * *'
        self.assertEqual((await self.web.get(route)).json()['status'], 'unknown')
        self.jobs['morning-a']['schedule']['expr'] = '30 8 * * *'
        self.configs['default']['timezone'] = 'UTC'
        self.assertFalse((await self.web.get(route)).json()['confirmed'])
        self.configs['default']['timezone'] = 'Asia/Taipei'
        self.jobs['evening-a']['next_run_at'] = '2030-10-15T19:00:00Z'
        self.assertFalse((await self.web.get(route)).json()['confirmed'])
        self.jobs['evening-a']['next_run'] = '2030-10-15T19:00:00+08:00'
        del self.jobs['evening-a']['next_run_at']
        self.assertTrue((await self.web.get(route)).json()['confirmed'])

    def test_original_today_writer_compare_backup_receipt_and_duplicate(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            target = root / '.hermes-app/today/hermes-today.json'
            request = {'workspace': str(root), 'overview_path': str(target), 'mode': 'refresh_overview_only',
                       'operation_id': 'fixture-operation', 'expected_board_sha256': 'missing'}
            (root/'writer.py').write_text(server.TODAY_WRITER)
            (root/'request.json').write_text(json.dumps(request))
            (root/'candidate.json').write_text(json.dumps(self.board()))
            def run():
                return subprocess.run([sys.executable, '-B', str(root/'writer.py'), str(root/'request.json'), str(root/'candidate.json')], capture_output=True, text=True)
            first = run()
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(json.loads(target.read_text())['refresh_receipts'][0]['request_id'], 'fixture-operation')
            self.assertIn('already-applied', run().stdout)
            request['operation_id'] = 'stale-operation'
            (root/'request.json').write_text(json.dumps(request))
            stale = run()
            self.assertNotEqual(stale.returncode, 0)
            self.assertIn('board changed', stale.stderr)
            request['expected_board_sha256'] = server.hashlib.sha256(target.read_bytes()).hexdigest()
            (root/'request.json').write_text(json.dumps(request))
            self.assertEqual(run().returncode, 0)
            self.assertTrue(target.with_name(target.name+'.before-stale-operation').is_file())
            self.assertEqual(len(json.loads(target.read_text())['refresh_receipts']), 2)

    def test_original_today_writer_preserves_matching_legacy_and_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            target = root/'.hermes-app/today/hermes-today.json'
            target.parent.mkdir(parents=True)
            legacy = root/'hermes-today.json'
            old = json.dumps(self.board()).encode()
            target.write_bytes(old)
            legacy.write_bytes(old)
            request = {'workspace': str(root), 'overview_path': str(target), 'mirror_path': str(legacy),
                       'mode': 'refresh_overview_only', 'operation_id': 'mirror-op', 'expected_board_sha256': server.hashlib.sha256(old).hexdigest()}
            (root/'request.json').write_text(json.dumps(request))
            (root/'candidate.json').write_text(json.dumps(self.board()))
            (root/'writer.py').write_text(server.TODAY_WRITER)
            def run():
                return subprocess.run([sys.executable, '-B', str(root/'writer.py'), str(root/'request.json'), str(root/'candidate.json')], capture_output=True, text=True)
            result = run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.read_bytes(), legacy.read_bytes())
            target.unlink()
            target.symlink_to(legacy)
            blocked = run()
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn('symlink refused', blocked.stderr)

    async def test_documents_fixed_profile_paths_and_readback(self):
        route = '/mobile/api/profile-documents/soul?profile=secondary'
        read = await self.web.get(route)
        self.assertEqual(read.status_code, 200)
        self.assertFalse(read.json()['exists'])
        save = await self.web.put(route, json={'revision': read.json()['revision'], 'content': '新的說明'})
        self.assertEqual(save.status_code, 200, save.text)
        self.assertEqual(save.json()['content'], '新的說明')
        self.assertEqual(self.files, {'/srv/hermes/.hermes/profiles/secondary/SOUL.md': '新的說明'})
        self.assertNotIn('path', save.json())

    async def test_root_redirect_is_anonymous_and_does_not_set_cookie(self):
        self.web.cookies.clear()
        before = dict(server.sessions)
        response = await self.web.get('/', follow_redirects=False)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers['location'], '/mobile/')
        self.assertNotIn('set-cookie', response.headers)
        self.assertEqual(server.sessions, before)
        self.assertEqual(self.native_calls, [])

    async def test_offline_login_is_json_502_clears_credentials_and_closes_client(self):
        marker = 'DUMMY_PASSWORD_ONLY_FOR_OFFLINE_FIXTURE'
        def unavailable(request):
            raise httpx.ConnectError(marker, request=request)
        offline = httpx.AsyncClient(base_url='http://fake-offline', transport=httpx.MockTransport(unavailable))
        captured = []
        original_json = server.Request.json
        async def capture_json(request):
            value = await original_json(request)
            captured.append(value)
            return value
        old_sessions = dict(server.sessions)
        with patch.object(server.httpx, 'AsyncClient', return_value=offline), patch.object(server.Request, 'json', capture_json):
            result = await self.web.post('/mobile/auth/login', json={'username': server.ADMIN, 'password': marker})
        self.assertEqual(result.status_code, 502, result.text)
        self.assertEqual(result.json()['detail'], '原 Hermes 暫時無法連線，請稍後再試')
        self.assertNotIn(marker, result.text)
        self.assertNotIn('set-cookie', result.headers)
        self.assertEqual(captured, [{}])
        self.assertTrue(offline.is_closed)
        self.assertEqual(server.failures, {})
        self.assertEqual(server.sessions, old_sessions)

    async def test_offline_me_is_json_502_and_logout_still_revokes_local_state(self):
        def unavailable(request):
            raise httpx.ConnectError('fixture disconnected', request=request)
        await self.backend.aclose()
        self.backend = httpx.AsyncClient(base_url='http://fake-offline', transport=httpx.MockTransport(unavailable))
        session = server.sessions['fixture']
        session.client = self.backend
        closed = []
        class Socket:
            async def close(self, code):
                closed.append(code)
        session.sockets.add(Socket())
        me = await self.web.get('/mobile/auth/me')
        self.assertEqual(me.status_code, 502, me.text)
        self.assertEqual(me.json()['detail'], '原 Hermes 暫時無法連線，請稍後再試')
        rejected = await self.web.post('/mobile/auth/logout', json={}, headers={'X-Mobile-CSRF': 'wrong'})
        self.assertEqual(rejected.status_code, 403)
        self.assertIn('fixture', server.sessions)
        self.assertEqual(closed, [])
        logout = await self.web.post('/mobile/auth/logout', json={})
        self.assertEqual(logout.status_code, 200, logout.text)
        self.assertTrue(logout.json()['ok'])
        self.assertFalse(logout.json()['upstream_logout'])
        self.assertIn('Max-Age=0', logout.headers['set-cookie'])
        self.assertEqual(server.sessions, {})
        self.assertTrue(self.backend.is_closed)
        self.assertEqual(closed, [1008])
        self.assertFalse(session.sockets)

    async def test_unavailable_native_login_status_does_not_count_as_bad_password(self):
        offline = httpx.AsyncClient(base_url='http://fake-offline', transport=httpx.MockTransport(
            lambda request: httpx.Response(503, text='fixture not ready')))
        with patch.object(server.httpx, 'AsyncClient', return_value=offline):
            result = await self.web.post('/mobile/auth/login', json={'username': server.ADMIN, 'password': 'dummy'})
        self.assertEqual(result.status_code, 502, result.text)
        self.assertEqual(server.failures, {})
        self.assertTrue(offline.is_closed)
        self.assertNotIn('set-cookie', result.headers)

    async def test_files_today_and_documents_do_not_need_local_traversal(self):
        root = '/srv/hermes/workspace'
        self.files[root+'/note.txt'] = 'Fixture'
        with patch.object(Path, 'resolve', side_effect=PermissionError('native private home has mode 0700')):
            route = '/mobile/api/profile-documents/soul?profile=secondary'
            initial = await self.web.get(route)
            self.assertEqual(initial.status_code, 200, initial.text)
            saved = await self.web.put(route, json={'revision': initial.json()['revision'], 'content': 'Fixture soul'})
            self.assertEqual(saved.status_code, 200, saved.text)
            for path, params in [('today', {}), ('files', {'path': root}), ('files/read', {'path': root+'/note.txt'})]:
                response = await self.web.get('/mobile/api/'+path, params=params)
                self.assertEqual(response.status_code, 200, response.text)
            upload = await self.web.post('/mobile/api/files/upload', json={'path': root+'/new.txt', 'data_url': data_url('new'), 'overwrite': False})
            self.assertEqual(upload.status_code, 200, upload.text)
            # session.cwd.set calls this same asynchronous metadata guard.
            data = await server.native_path_guard(server.sessions['fixture'], 'secondary', root, directory=True)
            self.assertEqual(data['path'], root)

    async def test_native_canonical_parent_leaf_and_broken_link_refuse_writes(self):
        root = '/srv/hermes/workspace'
        payload = {'path': root+'/note.txt', 'data_url': data_url('must not write'), 'overwrite': True}
        for metadata in [
            {'path': '/outside', 'entries': []},
            {'path': root, 'entries': [{'name': 'note.txt', 'path': '/outside/note.txt', 'is_directory': False}]},
            {'path': root, 'entries': [{'name': 'note.txt', 'path': root+'/note.txt', 'is_directory': False, 'broken_link': True}]},
        ]:
            self.directory_responses[root] = (200, metadata)
            result = await self.web.post('/mobile/api/files/upload', json=payload)
            self.assertEqual(result.status_code, 403, result.text)
        self.assertFalse(any(call[1] == '/api/files/upload' for call in self.native_calls))
        today = await self.web.get('/mobile/api/today')
        # Workspace itself is canonical even if a child is a broken link.
        self.assertEqual(today.status_code, 200)
        self.directory_responses[root] = (200, {'path': '/outside', 'entries': []})
        self.assertEqual((await self.web.get('/mobile/api/today')).status_code, 403)
        with self.assertRaises(server.HTTPException):
            await server.native_path_guard(server.sessions['fixture'], 'secondary', root, directory=True)

    async def test_missing_parent_is_not_created_and_document_alias_is_not_returned(self):
        route = '/mobile/api/profile-documents/memory?profile=secondary'
        target = '/srv/hermes/.hermes/profiles/secondary/memories/MEMORY.md'
        initial = (await self.web.get(route)).json()
        self.directory_responses[str(Path(target).parent)] = (404, {'detail': 'missing'})
        result = await self.web.put(route, json={'revision': initial['revision'], 'content': 'new'})
        self.assertEqual(result.status_code, 409, result.text)
        self.assertFalse(any(call[1] == '/api/files/upload' for call in self.native_calls))
        self.files[target] = 'must never reach browser'
        self.read_paths[target] = '/outside/MEMORY.md'
        result = await self.web.get(route)
        self.assertEqual(result.status_code, 502)
        self.assertNotIn('must never reach browser', result.text)

    async def test_generic_readback_path_must_stay_exact(self):
        root = '/srv/hermes/workspace'
        target = root+'/file.txt'
        self.files[target] = 'must never reach browser'
        self.read_paths[target] = '/outside/file.txt'
        result = await self.web.get('/mobile/api/files/read', params={'path': target})
        self.assertEqual(result.status_code, 409, result.text)
        self.assertNotIn('must never reach browser', result.text)

    async def test_stale_document_and_client_chosen_path_are_rejected(self):
        route = '/mobile/api/profile-documents/memory?profile=default'
        old = (await self.web.get(route)).json()
        target = '/srv/hermes/.hermes/memories/MEMORY.md'
        self.files[target] = 'newer native edit'
        stale = await self.web.put(route, json={'revision': old['revision'], 'content': 'old editor'})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(self.files[target], 'newer native edit')
        invalid = await self.web.put(route, json={'revision': old['revision'], 'content': 'x', 'path': '/etc/passwd'})
        self.assertEqual(invalid.status_code, 400)
        self.assertFalse(any(call[1] == '/api/files/upload' for call in self.native_calls))

    async def test_settings_safe_projection_and_partial_merge(self):
        route = '/mobile/api/settings?profile=secondary'
        read = await self.web.get(route)
        self.assertNotIn('DUMMY_HIDDEN', read.text)
        saved = await self.web.put(route, json={'revision': read.json()['revision'], 'settings': {'display': {'show_reasoning': False}}})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertFalse(saved.json()['settings']['display']['show_reasoning'])
        writes = [call for call in self.native_calls if call[0] == 'PUT']
        self.assertEqual(writes[0][3]['config'], {'display': {'show_reasoning': False}})
        self.assertEqual(self.configs['secondary']['model']['api_key'], 'DUMMY_HIDDEN')
        self.assertTrue(self.configs['default']['display']['show_reasoning'])

    async def test_settings_forbid_secrets_and_stale_versions(self):
        route = '/mobile/api/settings'
        read = (await self.web.get(route)).json()
        forbidden = await self.web.put(route, json={'revision': read['revision'], 'settings': {'model': {'api_key': 'new'}}})
        self.assertEqual(forbidden.status_code, 400)
        self.configs['default']['timezone'] = 'UTC'
        stale = await self.web.put(route, json={'revision': read['revision'], 'settings': {'timezone': 'Asia/Taipei'}})
        self.assertEqual(stale.status_code, 409)
        self.assertFalse(any(call[0] == 'PUT' for call in self.native_calls))

    async def test_model_choices_must_come_from_native_catalog(self):
        route = '/mobile/api/settings'
        read = (await self.web.get(route)).json()
        invalid = await self.web.put(route, json={'revision': read['revision'], 'settings': {'model': {'provider': 'evil', 'default': 'model-b'}}})
        self.assertEqual(invalid.status_code, 400)
        valid = await self.web.put(route, json={'revision': read['revision'], 'settings': {'model': {'provider': 'native', 'default': 'model-b'}}})
        self.assertEqual(valid.status_code, 200, valid.text)
        self.assertEqual(self.configs['default']['model']['default'], 'model-b')

    async def test_model_catalog_preserves_reasoning_capabilities_without_private_metadata(self):
        response = await self.web.get('/mobile/api/model/options?profile=secondary')
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['providers'][0]['capabilities']['model-a'],
            {'reasoning': True, 'can_disable_reasoning': False})
        self.assertIn('ultra', payload['reasoning_levels'])
        self.assertNotIn('DUMMY_HIDDEN', response.text)

    async def test_audio_only_relays_valid_recording_and_text(self):
        bad = await self.web.post('/mobile/api/audio/transcribe', json={'data_url': data_url('not audio', 'text/html')})
        self.assertEqual(bad.status_code, 400)
        transcribed = await self.web.post('/mobile/api/audio/transcribe?profile=secondary', json={'data_url': data_url(b'fixture', 'audio/webm'), 'mime_type': 'audio/webm'})
        self.assertEqual(transcribed.status_code, 200, transcribed.text)
        self.assertEqual(transcribed.json()['transcript'], '你好，這是測試。')
        self.assertNotIn('DUMMY_HIDDEN', transcribed.text)
        long_text = await self.web.post('/mobile/api/audio/speak', json={'text': 'a' * 8001})
        self.assertEqual(long_text.status_code, 400)
        spoken = await self.web.post('/mobile/api/audio/speak', json={'text': '您好'})
        self.assertEqual(spoken.status_code, 200, spoken.text)
        self.assertTrue(spoken.json()['data_url'].startswith('data:audio/wav;'))
        extra = await self.web.post('/mobile/api/audio/speak', json={'text': 'x', 'api_key': 'forbidden'})
        self.assertEqual(extra.status_code, 400)

    async def test_inventory_rejects_unknown_and_verifies_exact_toggle(self):
        unknown = await self.web.put('/mobile/api/inventory/skills/enabled', json={'name': 'unknown', 'enabled': False})
        self.assertEqual(unknown.status_code, 404)
        for kind in ('skills', 'toolsets', 'mcp'):
            saved = await self.web.put('/mobile/api/inventory/' + kind + '/enabled', json={'name': 'sample', 'enabled': False})
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertTrue(saved.json()['verified'])
            self.assertNotIn('DUMMY_HIDDEN', saved.text)
        self.assertEqual(self.configs['default']['agent']['disabled_toolsets'], ['old', 'sample'])
        content = await self.web.get('/mobile/api/inventory/skills/content?name=sample')
        self.assertEqual(content.status_code, 200, content.text)
        self.assertNotIn('path', content.json())

    async def test_login_replacement_revokes_previous_browser_socket(self):
        from unittest.mock import patch
        class Socket:
            closed = False
            async def close(self, code):
                self.closed = code == 1008
        old_socket = Socket()
        server.sessions['fixture'].sockets.add(old_socket)
        native = httpx.AsyncClient(base_url='http://fake-login', transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={'ok': True, 'authenticated': True})))
        with patch.object(server.httpx, 'AsyncClient', return_value=native), \
                patch.object(server.app.state, 'scope_salt', b'fixture-salt', create=True):
            response = await self.web.post('/mobile/auth/login', json={'username': server.ADMIN, 'password': 'dummy'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(old_socket.closed)
        self.assertNotIn('fixture', server.sessions)
        self.assertTrue(self.backend.is_closed)
        await native.aclose()

    async def test_write_requires_original_auth_csrf_and_same_profile(self):
        route = '/mobile/api/profile-documents/soul?profile=secondary'
        read = (await self.web.get(route)).json()
        mismatch = await self.web.put(route, json={'profile': 'default', 'content': 'x', 'revision': read['revision']})
        self.assertEqual(mismatch.status_code, 403)
        badcsrf = await self.web.put(route, json={'content': 'x', 'revision': read['revision']}, headers={'X-Mobile-CSRF': 'wrong'})
        self.assertEqual(badcsrf.status_code, 403)
        badprofile = await self.web.get('/mobile/api/settings?profile=unknown')
        self.assertEqual(badprofile.status_code, 403)
        self.assertFalse(any(call[0] in ('PUT', 'POST') for call in self.native_calls))


if __name__ == '__main__':
    unittest.main(verbosity=2)
