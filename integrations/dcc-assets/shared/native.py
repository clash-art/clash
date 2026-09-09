"""Native execution helpers. This is full local Python access, not a sandbox."""
from contextlib import redirect_stdout, redirect_stderr
import io
import json


class _Output(io.TextIOBase):
    def __init__(self):
        self.text = ''

    def write(self, text):
        self.text = (self.text + text)[-64000:]
        return len(text)

    def flush(self):
        pass


def execute_python(code, native_namespace):
    if not isinstance(code, str) or not code.strip() or len(code) > 100000:
        raise ValueError('Provide a nonempty Python script of at most 100000 characters.')
    namespace = dict(native_namespace)
    output = _Output()
    try:
        with redirect_stdout(output), redirect_stderr(output):
            exec(compile(code, '<clash-agent>', 'exec'), namespace, namespace)
        result = namespace.get('result')
        # Never silently turn a native object into an unverifiable string.
        json.dumps(result, allow_nan=False)
        return dict(stdout=output.text, result=result)
    except Exception as error:
        raise RuntimeError(str(error) + '\nChanges may have partially applied. Inspect the scene before retrying.\n' + output.text[-4000:]) from error


def workspace_file(root, value):
    from pathlib import Path
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Provide a saved file in the connected working folder.')
    path = (Path(root) / value).resolve()
    if not path.is_relative_to(Path(root).resolve()) or not path.is_file():
        raise ValueError('The material file must exist inside the connected working folder.')
    return path
