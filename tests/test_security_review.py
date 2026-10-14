"""Independent offline security regressions; no credentials or live endpoints.

Run with the existing mobile venv inside a network-denied filesystem sandbox.
TMPDIR must point to disposable, private scratch.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

os.environ['HERMES_MOBILE_DEV'] = '1'
os.environ['HERMES_MOBILE_ORIGIN'] = 'http://127.0.0.1:9180'
os.environ['HERMES_MOBILE_ADMIN'] = 'fixture-admin'
os.environ['HERMES_MOBILE_PROFILES'] = 'default,secondary'
os.environ['HERMES_MOBILE_FILE_ROOT'] = '/srv/hermes'
spec = importlib.util.spec_from_file_location('review_mobile_server', Path(__file__).parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)


class FileAndFrameTests(unittest.TestCase):
    def test_symlink_read_and_new_upload_parent_cannot_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'root'
            root.mkdir()
            outside = Path(directory) / 'outside'
            outside.mkdir()
            (outside / 'note.txt').write_text('dummy private content')
            (root / 'alias').symlink_to(outside, target_is_directory=True)
            with patch.object(server, 'WORKSPACE_ROOT', root):
                for path in (root / 'alias/note.txt', root / 'alias/new.txt', root / '../outside/note.txt'):
                    with self.subTest(path=path), self.assertRaises(server.HTTPException):
                        server.check_file(str(path))
                self.assertEqual(server.check_file(str(root / 'new.txt')), str(root / 'new.txt'))

    def test_symlink_to_secret_inside_root_is_denied(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env').write_text('DUMMY=fixture')
            (root / 'report.txt').symlink_to(root / '.env')
            with patch.object(server, 'WORKSPACE_ROOT', root), self.assertRaises(server.HTTPException):
                server.check_file(str(root / 'report.txt'))

    def test_typed_ids_and_invalid_ids(self):
        self.assertNotEqual(server.rpc_key(1), server.rpc_key('1'))
        for value in (None, True, {}, [], 1.0, 'x' * 161):
            with self.subTest(value=value), self.assertRaises(server.HTTPException):
                server.rpc_key(value)

    def test_rpc_and_event_diagnostics_are_redacted(self):
        marker = 'DUMMY_PROVIDER_SECRET_123'
        frames = [
            {'id': 1, 'error': {'code': -1, 'message': marker, 'data': {'traceback': marker}}},
            {'method': 'event', 'params': {'type': 'message.complete', 'payload': {'error': marker, 'api_key': marker}}},
        ]
        for frame in frames:
            self.assertNotIn(marker, json.dumps(server.public_frame(frame)))


class FakeResponse:
    status_code = 200
    def json(self):
        return {'ticket': 'dummy-ticket', 'providers': [{'slug': 'native', 'models': ['model-a'], 'authenticated': True}]}


class FakeClient:
    cookies = {}
    async def get(self, *args, **kwargs):
        return FakeResponse()
    async def post(self, *args, **kwargs):
        return FakeResponse()


class FakeSocket:
    def __init__(self):
        self.cookies = {server.COOKIE: 'dummy-session'}
        self.headers = {'origin': server.ORIGIN}
        self.query_params = {'csrf': 'dummy-csrf'}
        self.received = asyncio.Queue()
        self.sent = asyncio.Queue()
    async def accept(self):
        pass
    async def close(self, **kwargs):
        pass
    async def receive_json(self):
        return await self.received.get()
    async def send_json(self, value):
        await self.sent.put(value)


class FakeUpstream:
    def __init__(self):
        self.received = asyncio.Queue()
        self.sent = asyncio.Queue()
    async def __aenter__(self):
        return self
    async def __aexit__(self, *args):
        pass
    def __aiter__(self):
        return self
    async def __anext__(self):
        return json.dumps(await self.received.get())
    async def send(self, value):
        await self.sent.put(json.loads(value))


class SocketBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ws, self.up = FakeSocket(), FakeUpstream()
        server.sessions['dummy-session'] = server.Session(FakeClient(), 'dummy-csrf')
        self.db = sqlite3.connect(':memory:')
        self.db.execute('CREATE TABLE deliveries (id TEXT PRIMARY KEY, scope TEXT, fingerprint TEXT, state TEXT, response TEXT)')
        self.db.execute('CREATE TABLE delivery_sessions (id TEXT PRIMARY KEY, profile TEXT, stored_id TEXT)')
        server.app.state.ledger = self.db
        self.mock = patch.object(server.websockets, 'connect', return_value=self.up)
        self.mock.start()
        self.task = asyncio.create_task(server.socket(self.ws))

    async def asyncTearDown(self):
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        self.mock.stop()
        server.sessions.clear()
        self.db.close()

    async def receive(self, queue):
        return await asyncio.wait_for(queue.get(), 1)

    async def request(self, method, params, rid='review-1'):
        await self.ws.received.put({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params})

    async def bind(self):
        await self.request('session.create', {'profile': 'default'})
        await self.receive(self.up.sent)
        await self.up.received.put({'jsonrpc': '2.0', 'id': 'review-1', 'result': {'session_id': 'runtime-1', 'stored_session_id': 'stored-1'}})
        await self.receive(self.ws.sent)

    async def test_create_extra_settings_are_not_forwarded(self):
        await self.request('session.create', {'profile': 'default', 'cwd': '/etc'})
        self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())

    async def test_fresh_resume_requires_same_connection_profile_binding(self):
        await self.bind()
        await self.request('session.resume', {'session_id': 'runtime-1', 'profile': 'default'}, 'resume')
        forwarded = await self.receive(self.up.sent)
        self.assertEqual(forwarded['method'], 'session.resume')
        self.assertEqual(forwarded['params']['session_id'], 'stored-1')
        await self.request('session.resume', {'session_id': 'runtime-1', 'profile': 'secondary'}, 'foreign')
        self.assertIn('error', await self.receive(self.ws.sent))

    async def test_reasoning_reader_and_levels_are_bound_and_cannot_read_credentials(self):
        await self.bind()
        await self.request('config.get', {'session_id': 'runtime-1', 'profile': 'default', 'key': 'reasoning'}, 'get')
        self.assertEqual((await self.receive(self.up.sent))['params']['key'], 'reasoning')
        for index, effort in enumerate(('none', 'minimal', 'ultra')):
            await self.request('config.set', {'session_id': 'runtime-1', 'profile': 'default',
                'scope': 'session', 'key': 'reasoning', 'value': effort}, 'level-' + str(index))
            self.assertEqual((await self.receive(self.up.sent))['params']['value'], effort)
        for index, params in enumerate(({'key': 'api_key'}, {'key': 'reasoning', 'profile': 'secondary'})):
            await self.request('config.get', {'session_id': 'runtime-1', 'profile': 'default', **params}, 'deny-' + str(index))
            self.assertIn('error', await self.receive(self.ws.sent))
        await self.request('config.set', {'session_id': 'runtime-1', 'profile': 'default',
            'scope': 'global', 'key': 'reasoning', 'value': 'high'}, 'global')
        self.assertIn('error', await self.receive(self.ws.sent))

    async def test_model_setter_rejects_global_or_extra_command_flags(self):
        await self.bind()
        for index, value in enumerate(('model-a --provider native --global',
            'model-a --provider native --session --api-key secret')):
            await self.request('config.set', {'session_id': 'runtime-1', 'profile': 'default',
                'scope': 'session', 'key': 'model', 'value': value}, 'model-' + str(index))
            self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())

    async def test_model_setter_forwards_only_catalog_pair_and_explicit_confirmation(self):
        await self.bind()
        params = {'session_id': 'runtime-1', 'profile': 'default', 'scope': 'session',
            'key': 'model', 'value': 'model-a --provider native --session', 'confirm_expensive_model': True}
        await self.request('config.set', params, 'model')
        self.assertEqual((await self.receive(self.up.sent))['params'], params)
        await self.request('config.set', {**params, 'value': 'model-a --provider other --session'}, 'unknown')
        self.assertIn('error', await self.receive(self.ws.sent))

    async def test_duplicate_pending_id_does_not_replace_original(self):
        await self.request('session.create', {'profile': 'default'})
        await self.receive(self.up.sent)
        await self.request('session.create', {'profile': 'secondary'})
        self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())
        await self.up.received.put({'jsonrpc': '2.0', 'id': 'review-1', 'result': {'session_id': 'runtime-1'}})
        await self.receive(self.ws.sent)
        await self.request('session.status', {'profile': 'secondary', 'session_id': 'runtime-1'}, 'next')
        self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())

    async def test_unobserved_server_answer_is_denied(self):
        await self.ws.received.put({'jsonrpc': '2.0', 'id': 'invented', 'result': {'choice': 'once'}})
        self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())

    async def test_clarify_lock_cannot_change_observed_profile(self):
        await self.bind()
        await self.up.received.put({'jsonrpc': '2.0', 'id': 'clarify-1', 'method': 'clarify',
                                    'params': {'session_id': 'runtime-1', 'profile': 'default',
                                               'questions': [{'qid': 'q1', 'question': 'Fixture?'}]}})
        await self.receive(self.ws.sent)
        await self.request('clarify.lock', {'request_id': 'clarify-1', 'question_id': 'q1', 'answer': 'fixture', 'profile': 'secondary'}, 'lock')
        # A forwarded frame is the precise failure, without invoking a real backend.
        response_task = asyncio.create_task(self.ws.sent.get())
        forward_task = asyncio.create_task(self.up.sent.get())
        done, pending = await asyncio.wait([response_task, forward_task], timeout=1, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self.assertNotIn(forward_task, done, 'cross-profile clarify.lock reached upstream')
        self.assertIn(response_task, done)
        self.assertIn('error', response_task.result())

    async def test_observed_clarify_allows_answer_but_rejects_unknown_question(self):
        await self.bind()
        await self.up.received.put({'jsonrpc': '2.0', 'id': 'clarify-1', 'method': 'clarify',
                                    'params': {'session_id': 'runtime-1', 'profile': 'default',
                                               'questions': [{'qid': 'q1', 'question': 'Fixture?'}]}})
        await self.receive(self.ws.sent)
        params = {'request_id': 'clarify-1', 'question_id': 'foreign', 'answer': 'fixture', 'profile': 'default'}
        await self.request('clarify.lock', dict(params), 'bad-question')
        self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())
        params['question_id'] = 'q1'
        await self.request('clarify.lock', params, 'good-question')
        forwarded = await self.receive(self.up.sent)
        self.assertEqual(forwarded['params']['answer'], 'fixture')

    async def test_recovered_request_preserves_original_id_and_scope(self):
        await self.request('session.resume', {'profile': 'default', 'session_id': 'stored-1'})
        await self.receive(self.up.sent)
        await self.up.received.put({'jsonrpc': '2.0', 'id': 'review-1', 'result': {
            'session_id': 'runtime-1', 'open_requests': [
                {'id': 'original-approval', 'method': 'approval', 'params': {'session_id': 'runtime-1', 'profile': 'default'}},
                {'id': 'foreign-approval', 'method': 'approval', 'params': {'session_id': 'runtime-2', 'profile': 'secondary'}},
            ]}})
        await self.receive(self.ws.sent)
        await self.ws.received.put({'jsonrpc': '2.0', 'id': 'foreign-approval', 'result': {'choice': 'once'}})
        self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())
        await self.ws.received.put({'jsonrpc': '2.0', 'id': 'original-approval', 'result': {'choice': 'once'}})
        self.assertEqual((await self.receive(self.up.sent))['id'], 'original-approval')
        await self.ws.received.put({'jsonrpc': '2.0', 'id': 'original-approval', 'result': {'choice': 'once'}})
        self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())

    async def test_cancelled_request_cannot_be_answered(self):
        await self.bind()
        await self.up.received.put({'jsonrpc': '2.0', 'id': 'approval-1', 'method': 'approval',
                                    'params': {'session_id': 'runtime-1', 'profile': 'default'}})
        await self.receive(self.ws.sent)
        await self.up.received.put({'jsonrpc': '2.0', 'method': 'event', 'params': {
            'type': 'request.cancel', 'session_id': 'runtime-1', 'payload': {'id': 'approval-1'}}})
        await self.receive(self.ws.sent)
        await self.ws.received.put({'jsonrpc': '2.0', 'id': 'approval-1', 'result': {'choice': 'once'}})
        self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())

    async def test_unsupported_request_declines_without_cancelling_desktop(self):
        await self.bind()
        await self.up.received.put({'jsonrpc': '2.0', 'id': 'secret-1', 'method': 'secret',
                                    'params': {'session_id': 'runtime-1', 'profile': 'default'}})
        response = await self.receive(self.up.sent)
        self.assertEqual(response['error']['code'], 4404,
                         'non-4404 errors globally settle the native pending request')

    async def test_receipt_is_bound_to_stored_session_and_never_resubmits(self):
        import httpx
        submission = 'fixture-submission-123456'
        self.db.execute('INSERT INTO deliveries VALUES(?,?,?,?,?)', (submission, 'default:runtime-1', 'dummy', 'sending', None))
        self.db.execute('INSERT INTO delivery_sessions VALUES(?,?,?)', (submission, 'default', 'stored-1'))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url='http://fixture',
                                     cookies={server.COOKIE: 'dummy-session'}) as client:
            route = '/mobile/api/deliveries/' + submission
            response = await client.get(route, params={'profile': 'default', 'session_id': 'stored-1'})
            self.assertEqual(response.json()['state'], 'unknown')
            self.db.execute('UPDATE deliveries SET state=?,response=? WHERE id=?', ('acknowledged', json.dumps({'result': {'ok': True}}), submission))
            response = await client.get(route, params={'profile': 'default', 'session_id': 'stored-1'})
            self.assertEqual(response.json()['state'], 'accepted')
            self.db.execute('UPDATE deliveries SET response=? WHERE id=?', (json.dumps({'error': {'code': -1, 'message': 'DUMMY_SECRET'}}), submission))
            response = await client.get(route, params={'profile': 'default', 'session_id': 'stored-1'})
            self.assertEqual(response.json()['state'], 'rejected')
            self.assertNotIn('DUMMY_SECRET', response.text)
            for query in ({'profile': 'secondary', 'session_id': 'stored-1'}, {'profile': 'default', 'session_id': 'another-stored'}):
                self.assertEqual((await client.get(route, params=query)).status_code, 404)
            client.cookies.clear()
            self.assertEqual((await client.get(route, params={'profile':'default','session_id':'stored-1'})).status_code, 401)
        self.assertTrue(self.up.sent.empty(), 'read-only reconciliation must never resend a prompt')

    async def test_expired_clarify_cannot_be_answered(self):
        await self.bind()
        await self.up.received.put({'jsonrpc':'2.0','id':'question-parent','method':'clarify',
            'params':{'session_id':'runtime-1','profile':'default','questions':[{'qid':'one','question':'Fixture?'}]}})
        await self.receive(self.ws.sent)
        await self.up.received.put({'jsonrpc':'2.0','method':'event','params':{'type':'clarify.expired',
            'session_id':'runtime-1','payload':{'request_id':'question-parent'}}})
        await self.receive(self.ws.sent)
        await self.request('clarify.lock', {'request_id':'question-parent','question_id':'one','answer':'fixture','profile':'default'}, 'late')
        self.assertIn('error', await self.receive(self.ws.sent))
        self.assertTrue(self.up.sent.empty())

    async def test_ack_replay_is_sanitized_and_does_not_resend(self):
        await self.bind()
        params = {'session_id': 'runtime-1', 'profile': 'default', 'text': 'fixture', 'client_submission_id': 'review-delivery-123456'}
        await self.request('prompt.submit', dict(params), 'prompt')
        await self.receive(self.up.sent)
        await self.up.received.put({'jsonrpc': '2.0', 'id': 'prompt', 'error': {'code': -1, 'message': 'DUMMY_SECRET'}})
        self.assertNotIn('DUMMY_SECRET', json.dumps(await self.receive(self.ws.sent)))
        await self.request('prompt.submit', dict(params), 'replay')
        self.assertNotIn('DUMMY_SECRET', json.dumps(await self.receive(self.ws.sent)))
        self.assertTrue(self.up.sent.empty())


if __name__ == '__main__':
    unittest.main(verbosity=2)
