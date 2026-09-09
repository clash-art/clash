"""Native DCC transport through the public Clash CLI, with no Host internals."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid


class BridgeError(RuntimeError):
    pass


class Job:
    """Poll from the host UI timer. No Python worker thread touches DCC state."""

    def __init__(self, command, cwd, finish, cleanup=lambda: None, timeout=180):
        self._out = tempfile.TemporaryFile()
        self._err = tempfile.TemporaryFile()
        self._finish = finish
        self._cleanup = cleanup
        self._deadline = time.monotonic() + timeout
        self.done = False
        self.value = None
        self.error = None
        try:
            self._process = subprocess.Popen(
                command, cwd=str(cwd), stdin=subprocess.DEVNULL,
                stdout=self._out, stderr=self._err, shell=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        except OSError as error:
            self._out.close()
            self._err.close()
            cleanup()
            raise BridgeError('Cannot start Clash CLI. Set its executable path in Connection. ' + str(error)) from error

    def poll(self):
        if self.done:
            return True
        code = self._process.poll()
        if code is None and time.monotonic() < self._deadline:
            return False
        try:
            if code is None:
                self._process.kill()
                self._process.wait()
                raise BridgeError('Clash timed out. Open Clash and retry; unchanged files reuse the same upload identity.')
            self._out.seek(0)
            self._err.seek(0)
            if code != 0:
                detail = self._err.read().decode('utf-8', errors='replace').strip()
                raise BridgeError(detail[-2000:] or 'Clash command failed. Open Clash and check the working folder.')
            try:
                result = json.loads(self._out.read())
            except (ValueError, UnicodeError) as error:
                raise BridgeError('Clash returned invalid JSON. Check the CLI version and executable path.') from error
            if not isinstance(result, dict):
                raise BridgeError('Clash returned an unexpected JSON response.')
            self.value = self._finish(result)
        except Exception as error:
            self.error = str(error)
        finally:
            self.done = True
            self._out.close()
            self._err.close()
            self._cleanup()
        return True

    def wait(self):
        while not self.poll():
            time.sleep(0.05)
        if self.error:
            raise BridgeError(self.error)
        return self.value

    def cancel(self):
        if not self.done:
            self._process.kill()
            self._process.wait()
            self.poll()


class AssetBridge:
    def __init__(self, working_directory, executable='clash'):
        if not str(working_directory).strip():
            raise BridgeError('Choose the Clash project working folder first.')
        self.root = Path(working_directory).expanduser().resolve()
        if not self.root.is_dir():
            raise BridgeError('The working folder does not exist.')
        self.executable = str(Path(executable).expanduser()) if executable.strip() else 'clash'

    def _start(self, args, finish, cleanup=lambda: None):
        return Job([self.executable, 'assets', *args, '--json'], self.root, finish, cleanup)

    def start_list(self):
        def finish(result):
            assets = result.get('assets')
            if not isinstance(assets, list):
                raise BridgeError('Clash did not return an asset list.')
            return [a for a in assets if isinstance(a, dict)
                    and a.get('id') and a.get('status') == 'ready'
                    and a.get('lifecycle', {}).get('state') == 'active']
        return self._start(['list'], finish)

    def start_send(self, file_path):
        source = Path(file_path).expanduser().resolve()
        if not source.is_file():
            raise BridgeError('Choose an existing material file.')
        # A multi-file glTF cannot be published as one immutable file.
        if source.suffix.lower() == '.gltf':
            raise BridgeError('Export a self-contained GLB first; external glTF buffers and textures are not transferred.')
        snapshot_dir = tempfile.TemporaryDirectory(prefix='clash-dcc-send-')
        snapshot = Path(snapshot_dir.name) / source.name
        try:
            shutil.copyfile(source, snapshot)
            digest = hashlib.sha256()
            with snapshot.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            identity = str(self.root) + '\n' + str(source) + '\n' + digest.hexdigest()
            asset_id = 'asset_' + uuid.uuid5(uuid.NAMESPACE_URL, identity).hex
        except Exception:
            snapshot_dir.cleanup()
            raise

        def finish(result):
            if result.get('assetId') != asset_id:
                raise BridgeError('Clash did not confirm this upload identity. Retry the unchanged file.')
            return result
        return self._start(['import', '--file', str(snapshot), '--asset-id', asset_id, '--no-link'],
                           finish, snapshot_dir.cleanup)

    def start_receive(self, asset_id):
        if not str(asset_id).strip():
            raise BridgeError('Select a material first.')

        link_name = 'dcc-' + uuid.uuid4().hex

        def finish(result):
            link = result.get('linkPath')
            if not isinstance(link, str) or not Path(link).is_absolute() or not Path(link).is_file():
                raise BridgeError('Clash did not return a readable local asset file.')
            source = Path(link)
            # Never give a DCC a symlink into the immutable Asset cache. Each
            # receive creates an editable copy and never replaces a local edit.
            destination = self.root / 'assets' / 'dcc'
            destination.mkdir(parents=True, exist_ok=True)
            name = re.sub(r'[^\w.-]', '_', str(asset_id))[:64].strip('.') or 'asset'
            # The unique link has no extension. The CLI's sourcePath retains
            # the Host-derived media extension; use it only for that suffix.
            source_suffix = Path(result.get('sourcePath') or link).suffix
            suffix = source_suffix if re.fullmatch(r'\.[A-Za-z0-9]{1,12}', source_suffix) else ''
            fd, path = tempfile.mkstemp(prefix=name + '-', suffix=suffix, dir=str(destination))
            try:
                with os.fdopen(fd, 'wb') as output, source.open('rb') as input_file:
                    shutil.copyfileobj(input_file, output)
            except Exception:
                Path(path).unlink(missing_ok=True)
                raise
            return Path(path)
        return self._start(['link', '--asset', str(asset_id), '--name', link_name], finish)

    def list_assets(self):
        return self.start_list().wait()

    def send_file(self, path):
        return self.start_send(path).wait()

    def receive_asset(self, asset_id):
        return self.start_receive(asset_id).wait()
