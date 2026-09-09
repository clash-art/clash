"""Session-authenticated loopback control, driven exclusively by native UI timers."""
from collections import OrderedDict
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import time
import uuid

MAX_REQUEST = 256 * 1024
MAX_RESPONSE = 16 * 1024 * 1024


class Pending:
    def __init__(self, job, finish=lambda value: value):
        self.job, self.finish = job, finish
        self.value = self.error = None

    def poll(self):
        if not self.job.poll():
            return False
        self.error = self.job.error
        if not self.error:
            try:
                self.value = self.finish(self.job.value)
            except Exception as error:
                self.error = str(error)
        return True

    def cancel(self):
        self.job.cancel()


class ControlServer:
    def __init__(self, app, workspace, handler, discovery_root=None, blocked=lambda: False):
        self.app = app
        self.workspace = Path(workspace).resolve()
        self.handler, self.blocked = handler, blocked
        self.session_id = uuid.uuid4().hex
        self.token = secrets.token_hex(32)
        key = str(self.workspace).lower() if os.name == 'nt' else str(self.workspace)
        directory = (Path(discovery_root) if discovery_root else Path.home() / '.clash' / 'dcc-connections') / hashlib.sha256(key.encode()).hexdigest()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.record_path = directory / (app + '.json')
        if self.record_path.exists():
            try:
                previous = json.loads(self.record_path.read_text())
                with socket.create_connection(('127.0.0.1', int(previous['port'])), timeout=0.2):
                    pass
            except (OSError, ValueError, KeyError):
                pass
            else:
                raise RuntimeError('This working folder already has a connected ' + app + ' instance. Disconnect it first.')
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(8)
        self.listener.setblocking(False)
        self.peers = []
        self.seen = {}
        self.responses = OrderedDict()
        self.closed = False
        self.executing = False
        record = dict(protocol=1, app=app, workspace=str(self.workspace), pid=os.getpid(),
                      port=self.listener.getsockname()[1], sessionId=self.session_id, token=self.token)
        temporary = directory / (self.session_id + '.tmp')
        try:
            fd = os.open(str(temporary), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                json.dump(record, output)
            os.replace(temporary, self.record_path)
        except Exception:
            self.listener.close()
            temporary.unlink(missing_ok=True)
            raise

    @property
    def busy(self):
        return self.executing or any(peer.get('pending') for peer in self.peers)

    @staticmethod
    def _error(request_id, code, message):
        return dict(id=request_id, ok=False, error=dict(code=code, message=message))

    def _respond(self, peer, response, remember=False):
        try:
            encoded = (json.dumps(response, ensure_ascii=False, allow_nan=False) + '\n').encode()
            if len(encoded) > MAX_RESPONSE:
                raise ValueError('Result exceeds the response limit. Read the scene before retrying a mutation.')
        except (TypeError, ValueError) as error:
            response = self._error(response.get('id'), 'RESULT_ENCODING_FAILED', str(error))
            encoded = (json.dumps(response) + '\n').encode()
        if remember:
            self.responses[response['id']] = encoded
            if len(self.responses) > 32:
                self.responses.popitem(last=False)
        peer['output'] = encoded
        peer['pending'] = None

    def _request(self, peer, raw):
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError('Expected a JSON request object.')
        request_id = request.get('id')
        token = request.get('token')
        if not isinstance(token, str) or not secrets.compare_digest(token, self.token) or request.get('sessionId') != self.session_id:
            self._respond(peer, self._error(request_id, 'UNAUTHORIZED', 'Reconnect through the configured Clash plugin.'))
            return
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
            raise ValueError('A bounded request id is required.')
        action, params = request.get('action'), request.get('params', {})
        if not isinstance(action, str) or not isinstance(params, dict):
            raise ValueError('Expected an action and parameter object.')
        digest = hashlib.sha256(json.dumps([action, params], sort_keys=True).encode()).hexdigest()
        if request_id in self.seen:
            if self.seen[request_id] != digest:
                self._respond(peer, self._error(request_id, 'REQUEST_CONFLICT', 'This request id was already used with different parameters.'))
            elif request_id in self.responses:
                peer['output'] = self.responses[request_id]
            else:
                self._respond(peer, self._error(request_id, 'RESULT_UNAVAILABLE', 'The request may have executed. Read current scene state; do not blindly repeat it.'))
            return
        if request.get('expiresAt', time.time() * 1000 + 1) < time.time() * 1000:
            self._respond(peer, self._error(request_id, 'EXPIRED', 'Request expired before execution.'))
            return
        if self.busy or self.blocked():
            self._respond(peer, self._error(request_id, 'BUSY', 'The native plugin is transferring a material. Wait for it to finish.'))
            return
        if len(self.seen) >= 4096:
            self._respond(peer, self._error(request_id, 'SESSION_FULL', 'Reconnect the native plugin to start a new command session.'))
            return
        self.seen[request_id] = digest
        peer['id'] = request_id
        try:
            self.executing = True
            value = self.handler(action, params)
            if isinstance(value, Pending):
                peer['pending'] = value
                return
            self._respond(peer, dict(id=request_id, ok=True, value=value), remember=True)
        except Exception as error:
            self._respond(peer, self._error(request_id, 'DCC_OPERATION_FAILED', str(error)), remember=True)
        finally:
            self.executing = False

    def poll(self):
        if self.closed or self.executing:
            return
        try:
            connection, _ = self.listener.accept()
            connection.setblocking(False)
            if len(self.peers) >= 8:
                connection.close()
            else:
                self.peers.append(dict(socket=connection, input=b'', output=None, pending=None, started=time.monotonic()))
        except BlockingIOError:
            pass
        for peer in list(self.peers):
            try:
                if peer['pending']:
                    pending = peer['pending']
                    if pending.poll():
                        response = self._error(peer['id'], 'DCC_OPERATION_FAILED', pending.error) if pending.error else dict(id=peer['id'], ok=True, value=pending.value)
                        self._respond(peer, response, remember=True)
                elif peer['output'] is None:
                    chunk = peer['socket'].recv(65536)
                    if not chunk:
                        self._drop(peer)
                        continue
                    peer['input'] += chunk
                    if len(peer['input']) > MAX_REQUEST:
                        raise ValueError('Request is too large.')
                    if b'\n' in peer['input']:
                        self._request(peer, peer['input'].split(b'\n', 1)[0])
                if peer['output'] is not None:
                    sent = peer['socket'].send(peer['output'])
                    peer['output'] = peer['output'][sent:]
                    if not peer['output']:
                        self._drop(peer)
                elif not peer['pending'] and time.monotonic() - peer['started'] > 10:
                    self._drop(peer)
            except BlockingIOError:
                if not peer['pending'] and time.monotonic() - peer['started'] > 10:
                    self._drop(peer)
            except (ValueError, TypeError, KeyError) as error:
                self._respond(peer, self._error(None, 'INVALID_REQUEST', str(error)))
            except OSError:
                self._drop(peer)

    def _drop(self, peer):
        peer['socket'].close()
        if peer in self.peers:
            self.peers.remove(peer)

    def close(self):
        if self.closed:
            return
        self.closed = True
        for peer in list(self.peers):
            if peer['pending']:
                peer['pending'].cancel()
            self._drop(peer)
        self.listener.close()
        try:
            if json.loads(self.record_path.read_text()).get('sessionId') == self.session_id:
                self.record_path.unlink()
        except (OSError, ValueError):
            pass
