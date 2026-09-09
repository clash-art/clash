"""Adapt bundled MayaMCP operations to Clash's authenticated native transport.

Only packaged modules are discovered. Arguments are passed as Python values,
never interpolated into source code. No upstream MCP runtime is required.
"""
import copy
import importlib.util
import inspect
import json
from pathlib import Path
from typing import Any, Union, get_args, get_origin

_READ_ONLY = {'list_objects_by_type', 'get_object_attributes'}
_CACHE = {}


def _modules(root):
    root = Path(root).resolve()
    if root not in _CACHE:
        entries = {}
        for category in ('object', 'scene', 'material'):
            for path in sorted((root / category).glob('*.py')):
                spec = importlib.util.spec_from_file_location('clash_maya_' + path.stem, path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                fn = getattr(module, path.stem)
                entries[path.stem] = (fn, category)
        _CACHE[root] = entries
    return _CACHE[root]


def _schema(annotation):
    if annotation in (Any, inspect.Parameter.empty):
        return {}
    origin, args = get_origin(annotation), get_args(annotation)
    if origin is Union:
        return {'anyOf': [_schema(arg) for arg in args]}
    if annotation is type(None):
        return {'type': 'null'}
    if origin in (list, tuple) or annotation in (list, tuple):
        if origin is tuple and args and args[-1] is not Ellipsis:
            return {'type': 'array', 'prefixItems': [_schema(arg) for arg in args],
                    'minItems': len(args), 'maxItems': len(args)}
        return {'type': 'array', 'items': _schema(args[0]) if args else {}}
    if origin is dict or annotation is dict:
        return {'type': 'object', 'additionalProperties': _schema(args[1]) if args else {}}
    return {'type': {str: 'string', bool: 'boolean', int: 'integer', float: 'number'}[annotation]}


def catalog(root):
    tools = []
    for name, (fn, category) in sorted(_modules(root).items()):
        properties, required = {}, []
        for param in inspect.signature(fn).parameters.values():
            schema = _schema(param.annotation)
            if param.default is inspect.Parameter.empty:
                required.append(param.name)
            else:
                if param.default is None and schema and schema.get('type') != 'null':
                    schema = {'anyOf': [schema, {'type': 'null'}]}
                schema['default'] = copy.deepcopy(param.default)
            properties[param.name] = schema
        tools.append(dict(name=name, category=category, description=inspect.getdoc(fn) or name,
                          readOnly=name in _READ_ONLY, destructive=name not in _READ_ONLY,
                          inputSchema=dict(type='object', properties=properties,
                                           required=required, additionalProperties=False)))
    return tools


def _validate(value, schema, label):
    if 'anyOf' in schema:
        for option in schema['anyOf']:
            try:
                return _validate(value, option, label)
            except ValueError:
                pass
        raise ValueError(label + ': does not match any accepted type')
    kind = schema.get('type')
    valid = {'null': value is None, 'string': isinstance(value, str),
             'boolean': type(value) is bool, 'integer': type(value) is int,
             'number': type(value) in (int, float), 'array': isinstance(value, (list, tuple)),
             'object': isinstance(value, dict)}
    if kind and not valid[kind]:
        raise ValueError(label + ': expected ' + kind)
    if kind == 'number':
        return float(value)
    if kind == 'array':
        if 'prefixItems' in schema:
            if len(value) != len(schema['prefixItems']):
                raise ValueError(label + ': incorrect tuple length')
            return [_validate(v, s, label) for v, s in zip(value, schema['prefixItems'])]
        return [_validate(v, schema.get('items', {}), label) for v in value]
    if kind == 'object':
        return {k: _validate(v, schema.get('additionalProperties', {}), label + '.' + k)
                for k, v in value.items()}
    return value


def invoke(root, name, arguments):
    if not isinstance(name, str) or name not in _modules(root):
        raise ValueError('Unknown bundled Maya tool: ' + str(name))
    if not isinstance(arguments, dict):
        raise ValueError('Tool arguments must be a JSON object')
    fn, _ = _modules(root)[name]
    signature = inspect.signature(fn)
    bound = signature.bind(**arguments)
    bound.apply_defaults()
    schema = next(t['inputSchema'] for t in catalog(root) if t['name'] == name)
    values = {key: _validate(copy.deepcopy(value), schema['properties'][key], key)
              for key, value in bound.arguments.items()}
    result = fn(**values)
    if isinstance(result, dict) and result.get('success') is False:
        raise RuntimeError(str(result.get('message') or result.get('error') or result))
    json.dumps(result, allow_nan=False)
    return {'tool': name, 'result': result}
