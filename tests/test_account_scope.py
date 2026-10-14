"""Draft identity must survive restart and never alias a different owner/realm."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

os.environ['HERMES_MOBILE_DEV'] = '1'
os.environ['HERMES_MOBILE_ORIGIN'] = 'http://127.0.0.1:9180'
os.environ['HERMES_MOBILE_ADMIN'] = 'fixture-admin'
os.environ['HERMES_MOBILE_PROFILES'] = 'default,secondary'
os.environ['HERMES_MOBILE_FILE_ROOT'] = '/srv/hermes'
spec = importlib.util.spec_from_file_location('scope_mobile_server', Path(__file__).parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)


class ScopeTests(unittest.IsolatedAsyncioTestCase):
    async def test_restart_stability_and_owner_isolation(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(server, 'STATE', Path(folder)):
            session = server.Session(None, 'dummy-csrf')
            async with server.lifespan(server.app):
                first = server.csrf_payload(session)['account_scope']
                self.assertEqual(len(first),64)
                self.assertNotIn(server.ADMIN,first)
                with patch.object(server, 'ADMIN', 'another-fixture-owner'):
                    self.assertNotEqual(first,server.csrf_payload(session)['account_scope'])
                with patch.object(server, 'ORIGIN', 'https://another-fixture.invalid'):
                    self.assertNotEqual(first,server.csrf_payload(session)['account_scope'])
                self.assertEqual((Path(folder)/'account-scope.key').stat().st_mode & 0o777,0o600)
            async with server.lifespan(server.app):
                self.assertEqual(first,server.csrf_payload(session)['account_scope'])

    async def test_symlink_key_is_refused(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(server, 'STATE', Path(folder)):
            target=Path(folder)/'fixture-key'
            target.write_bytes(b'X'*32)
            (Path(folder)/'account-scope.key').symlink_to(target)
            with self.assertRaises(RuntimeError):
                async with server.lifespan(server.app):
                    pass
