"""Stdio runner for Clash executable plugins.

A v1 executable plugin speaks newline-delimited JSON over stdio:

- in:  ``clash.plugin.invoke/v1``
- out: ``clash.plugin.result/v1``
- side-channel: ``clash.plugin.broker-request/v1`` /
  ``clash.plugin.broker-response/v1`` for Host-injected asset, store, and tool calls.

``serve`` implements that loop so a plugin only supplies handlers::

    from clash_sdk.executable import serve

    async def submit(invocation, context):
        account = await context.store.get("apiKey")
        response = call_provider_directly(
            api_key=account,
            prompt=invocation["input"]["values"]["prompt"],
        )
        return [await context.upload({
            "slot": "media",
            "kind": "image",
            "url": response["body"]["url"],
            "mediaType": "image/png",
        })]

    if __name__ == "__main__":
        serve({"my-gateway-execute": {"submit": submit}})

Handlers are keyed by ``target.exportId`` — the same dispatch contract as the
JS executable-plugin adapter. A handler returns either a list of
outputs or a full ``clash.plugin.result/v1`` dict; raising surfaces as a
``failed`` result. Plugin code uses ordinary Python dependencies and network
clients directly; the Host side-channel is only for scoped asset/store/tool
dependencies contributed by the plugin.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import inspect
import json
import math
import re
import sys
import traceback
import urllib.request
from datetime import datetime
from typing import Any, Awaitable, Callable, Iterable, Mapping, TextIO
from urllib.parse import urlparse

INVOKE_PROTOCOL = "clash.plugin.invoke/v1"
RESULT_PROTOCOL = "clash.plugin.result/v1"
BROKER_REQUEST_PROTOCOL = "clash.plugin.broker-request/v1"
BROKER_RESPONSE_PROTOCOL = "clash.plugin.broker-response/v1"

_FAILURE_CODES = frozenset({
    "invalid_request",
    "authentication_failed",
    "permission_denied",
    "content_rejected",
    "rate_limited",
    "quota_exhausted",
    "provider_unavailable",
    "provider_failed",
    "task_not_found",
    "task_expired",
    "transport_timeout",
    "transport_error",
    "invalid_response",
    "execution_failed",
    "contract_violation",
    "cancelled",
    "plugin_unavailable",
    "deadline_exceeded",
    "output_persistence_failed",
    "publication_failed",
    "reference_unavailable",
})
_REQUEST_STATES = frozenset({"rejected", "unknown", "accepted"})
_FAILURE_ERROR_KEYS = frozenset({
    "code", "message", "retryable", "requestState", "providerCode", "details",
})

HostRequest = Callable[[Mapping[str, Any]], Awaitable[Any]]
Handler = Callable[[Mapping[str, Any], "ExecutablePluginContext"], Any]
HandlerSet = Mapping[str, Handler]


class HostDependencyError(RuntimeError):
    """A Host-injected dependency operation was rejected."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _request_state_for(operation: str) -> str:
    return "unknown" if operation == "submit" else "accepted"


def _failure_result(
    invocation_id: str,
    *,
    code: str,
    message: str,
    retryable: bool,
    request_state: str,
) -> Mapping[str, Any]:
    return {
        "protocol": RESULT_PROTOCOL,
        "invocationId": invocation_id,
        "status": "failed",
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "requestState": request_state,
        },
    }


def _is_json_value(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(entry) for entry in value)
    if isinstance(value, Mapping):
        return all(
            isinstance(key, str) and _is_json_value(entry)
            for key, entry in value.items()
        )
    return False


def _author_failure_error(error: Any, operation: str) -> Mapping[str, Any]:
    request_state = _request_state_for(operation)
    invalid = {
        "code": "contract_violation",
        "message": "Plugin returned an invalid failed result.",
        "retryable": False,
        "requestState": request_state,
    }
    if not isinstance(error, Mapping) or set(error) - _FAILURE_ERROR_KEYS:
        return invalid

    code = error.get("code")
    message = error.get("message")
    retryable = error.get("retryable")
    author_request_state = error.get("requestState")
    provider_code = error.get("providerCode")
    if (
        not isinstance(code, str)
        or code not in _FAILURE_CODES
        or not isinstance(message, str)
        or not message.strip()
        or not isinstance(retryable, bool)
        or not isinstance(author_request_state, str)
        or author_request_state not in _REQUEST_STATES
        or (
            "providerCode" in error
            and (not isinstance(provider_code, str) or not provider_code.strip())
        )
        or ("details" in error and not _is_json_value(error["details"]))
    ):
        return invalid

    return {
        "code": code,
        "message": message.strip(),
        "retryable": retryable,
        "requestState": author_request_state,
        **(
            {"providerCode": provider_code.strip()}
            if isinstance(provider_code, str)
            else {}
        ),
        **({"details": error["details"]} if "details" in error else {}),
    }


def _asset_handle_from_host(answer: Any) -> dict[str, Any]:
    """Validate the canonical handle before plugin business code can observe it."""
    if not isinstance(answer, Mapping):
        raise HostDependencyError("invalid_asset", "The Host returned an invalid Asset handle.")
    allowed = {"assetId", "uri", "kind", "mediaType"}
    if set(answer) - allowed:
        raise HostDependencyError("invalid_asset", "The Host returned an invalid Asset handle.")
    asset_id = answer.get("assetId")
    uri = answer.get("uri")
    kind = answer.get("kind")
    media_type = answer.get("mediaType")
    if (
        not isinstance(asset_id, str) or not asset_id.strip()
        or not isinstance(uri, str) or not uri.startswith("clash-asset://")
        or uri == "clash-asset://"
        or kind not in {"image", "video", "audio", "model"}
        or (
            "mediaType" in answer
            and (not isinstance(media_type, str) or not media_type.strip())
        )
    ):
        raise HostDependencyError("invalid_asset", "The Host returned an invalid Asset handle.")
    return dict(answer)


def _resolved_reference_from_host(answer: Any) -> dict[str, Any]:
    """Validate and decode the permanently named Asset delivery v0 result."""
    if not isinstance(answer, Mapping):
        raise HostDependencyError(
            "invalid_asset",
            "The Host returned an invalid resolved reference.",
        )

    form = answer.get("form")
    common = {"form", "kind", "mediaType"}
    if form == "provider-url":
        if set(answer) - (common | {"providerUrl", "expiresAt"}):
            raise HostDependencyError(
                "invalid_asset",
                "The Host returned an invalid resolved reference.",
            )
        provider_url = answer.get("providerUrl")
        expires_at = answer.get("expiresAt")
        if (
            not isinstance(provider_url, str) or not _valid_url(provider_url)
            or not isinstance(expires_at, str) or not _valid_utc_datetime(expires_at)
        ):
            raise HostDependencyError(
                "invalid_asset",
                "The Host returned an incomplete Provider URL.",
            )
        result = dict(answer)
    elif form == "bytes":
        if set(answer) - (common | {"bytesBase64"}):
            raise HostDependencyError(
                "invalid_asset",
                "The Host returned an invalid resolved reference.",
            )
        encoded = answer.get("bytesBase64")
        if not isinstance(encoded, str):
            raise HostDependencyError(
                "invalid_asset",
                "The Host returned no supported Asset representation.",
            )
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise HostDependencyError(
                "invalid_asset",
                "The Host returned invalid Asset bytes.",
            ) from error
        result = {
            "form": "bytes",
            "bytes": decoded,
            **({"kind": answer["kind"]} if answer.get("kind") else {}),
            **({"mediaType": answer["mediaType"]} if answer.get("mediaType") else {}),
        }
    elif form == "text":
        if set(answer) != {"form", "text"} or not isinstance(answer.get("text"), str):
            raise HostDependencyError(
                "invalid_asset",
                "The Host returned an invalid text reference.",
            )
        return {"form": "text", "text": answer["text"]}
    else:
        raise HostDependencyError(
            "invalid_asset",
            "The Host returned no supported Asset representation.",
        )

    kind = answer.get("kind")
    media_type = answer.get("mediaType")
    if (
        (
            "kind" in answer
            and kind not in {"image", "video", "audio", "model"}
        )
        or (
            "mediaType" in answer
            and (not isinstance(media_type, str) or not media_type.strip())
        )
    ):
        raise HostDependencyError(
            "invalid_asset",
            "The Host returned an invalid resolved reference.",
        )
    return result


def _valid_url(value: str) -> bool:
    """Match the absolute-URL requirement of the TypeScript v0 schema."""
    parsed = urlparse(value)
    return bool(
        parsed.scheme
        and (parsed.netloc or parsed.path or parsed.params or parsed.query or parsed.fragment)
    )


def _valid_utc_datetime(value: str) -> bool:
    """Match Zod's default datetime form: ISO date/time with a trailing Z."""
    if not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z",
        value,
    ):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def _write_line(out: TextIO, payload: Mapping[str, Any]) -> None:
    out.write(json.dumps(payload) + "\n")
    out.flush()


def _read_messages(stream: TextIO) -> Iterable[Mapping[str, Any]]:
    for raw in stream:
        raw = raw.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(message, dict):
            yield message


def _make_host_request(
    invocation_id: str,
    stdin: TextIO,
    stdout: TextIO,
    counter: dict[str, int],
) -> HostRequest:
    async def request_host(operation: Mapping[str, Any]) -> Any:
        counter["value"] += 1
        request_id = f"py-{invocation_id}-{counter['value']}"
        _write_line(stdout, {
            "protocol": BROKER_REQUEST_PROTOCOL,
            "requestId": request_id,
            "invocationId": invocation_id,
            "operation": dict(operation),
        })
        for message in _read_messages(stdin):
            if message.get("protocol") != BROKER_RESPONSE_PROTOCOL:
                continue
            if message.get("requestId") != request_id:
                continue
            if message.get("status") == "ok":
                return message.get("result")
            error = message.get("error") or {}
            raise HostDependencyError(
                str(error.get("code", "dependency_error")),
                str(error.get("message", "Host dependency request failed.")),
            )
        raise HostDependencyError("host_stream_closed", "Host dependency stream closed.")

    return request_host


class PluginStore:
    """Account state already bound to the active plugin invocation."""

    def __init__(self, request_host: HostRequest) -> None:
        self._request_host = request_host

    async def get(self, key: str) -> str | None:
        answer = await self._request_host({"kind": "store.get", "key": key})
        value = (answer or {}).get("value") if isinstance(answer, Mapping) else None
        return str(value) if value is not None else None

    async def put(
        self,
        key: str,
        value: str,
        *,
        secret: bool | None = None,
        expires_at: str | None = None,
    ) -> None:
        operation: dict[str, Any] = {"kind": "store.put", "key": key, "value": value}
        if secret is not None:
            operation["secret"] = secret
        if expires_at is not None:
            operation["expiresAt"] = expires_at
        await self._request_host(operation)

    async def remove(self, key: str) -> None:
        await self.put(key, "")


class CodexImagegenTool:
    def __init__(self, request_host: HostRequest) -> None:
        self._request_host = request_host

    async def generate(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        return _asset_handle_from_host(
            await self._request_host({"kind": "codex.image.generate", **dict(request)})
        )


class PluginHostTools:
    def __init__(self, request_host: HostRequest) -> None:
        self.codex_imagegen = CodexImagegenTool(request_host)


class ExecutablePluginContext:
    """Typed Host dependencies exposed to Python plugin handlers."""

    def __init__(self, request_host: HostRequest) -> None:
        self._request_host = request_host
        self.store = PluginStore(request_host)
        self.host_tools = PluginHostTools(request_host)

    async def reference(self, reference: Mapping[str, Any]) -> Mapping[str, Any]:
        return _resolved_reference_from_host(
            await self._request_host(
                {"kind": "asset.resolve", "reference": dict(reference)}
            )
        )

    async def asset(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        slot = str(request["slot"])
        operation: dict[str, Any] = {
            "kind": "asset.write",
            "slot": slot,
            "assetKind": request["kind"],
        }
        for source, target in (
            ("mediaType", "mediaType"),
            ("dataBase64", "dataBase64"),
            ("url", "url"),
        ):
            if request.get(source) is not None:
                operation[target] = request[source]
        handle = _asset_handle_from_host(await self._request_host(operation))
        return {"slot": slot, "kind": "asset", "asset": handle}

    async def upload(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        slot = str(request["slot"])
        raw_bytes = request.get("bytes")
        url = request.get("url")
        operation: dict[str, Any] = {
            "kind": "asset.upload-slot",
            "slot": slot,
            "assetKind": request["kind"],
        }
        if request.get("mediaType"):
            operation["mediaType"] = request["mediaType"]
        if raw_bytes is not None:
            operation["byteLength"] = len(raw_bytes)
        if url is not None:
            operation["url"] = url
        opened = await self._request_host(operation)
        if not isinstance(opened, Mapping):
            raise HostDependencyError("invalid_upload_slot", "The Host returned an invalid upload slot.")
        if url is not None and opened.get("assetId"):
            return {"slot": slot, "kind": "asset", "asset": _asset_handle_from_host(opened)}
        if raw_bytes is None or not opened.get("uploadUrl") or not opened.get("assetId"):
            raise HostDependencyError(
                "invalid_upload_slot",
                "The Host did not provide an upload URL and asset id.",
            )

        def put_bytes() -> None:
            upload = urllib.request.Request(
                str(opened["uploadUrl"]),
                data=bytes(raw_bytes),
                method="PUT",
                headers={"content-type": str(request.get("mediaType", "application/octet-stream"))},
            )
            with urllib.request.urlopen(upload) as response:  # noqa: S310 -- Host supplied URL
                if not 200 <= response.status < 300:
                    raise RuntimeError(f"Uploading {slot} failed with HTTP {response.status}.")

        await asyncio.to_thread(put_bytes)
        handle = _asset_handle_from_host(await self._request_host({
            "kind": "asset.write",
            "slot": slot,
            "assetKind": request["kind"],
            **({"mediaType": request["mediaType"]} if request.get("mediaType") else {}),
            "assetId": opened["assetId"],
        }))
        return {"slot": slot, "kind": "asset", "asset": handle}


async def _result_from(
    handler_value: Any,
    invocation_id: str,
    context: ExecutablePluginContext,
    operation: str,
) -> Mapping[str, Any]:
    if isinstance(handler_value, Mapping) and handler_value.get("status") == "failed":
        return {
            "protocol": RESULT_PROTOCOL,
            "invocationId": invocation_id,
            "status": "failed",
            "error": _author_failure_error(handler_value.get("error"), operation),
        }
    if isinstance(handler_value, Mapping) and handler_value.get("protocol") == RESULT_PROTOCOL:
        return handler_value
    if isinstance(handler_value, Mapping) and handler_value.get("status") == "accepted":
        return {
            "protocol": RESULT_PROTOCOL,
            "invocationId": invocation_id,
            **dict(handler_value),
        }
    if isinstance(handler_value, Mapping) and handler_value.get("status") == "completed":
        outputs = handler_value.get("outputs")
        if outputs is None and isinstance(handler_value.get("media"), Mapping):
            outputs = [
                await context.upload({"slot": slot, **dict(media)})
                for slot, media in handler_value["media"].items()
            ]
        return {
            "protocol": RESULT_PROTOCOL,
            "invocationId": invocation_id,
            "status": "completed",
            "outputs": outputs if isinstance(outputs, list) else [],
        }
    outputs = handler_value if isinstance(handler_value, list) else []
    return {
        "protocol": RESULT_PROTOCOL,
        "invocationId": invocation_id,
        "status": "completed",
        "outputs": outputs,
    }


def serve(
    handlers: Mapping[str, HandlerSet],
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
) -> None:
    """Run the executable-plugin stdio loop until stdin closes."""
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout

    for message in _read_messages(stdin):
        if message.get("protocol") != INVOKE_PROTOCOL:
            continue
        invocation_id = str(message.get("invocationId", ""))
        export_id = str((message.get("target") or {}).get("exportId", ""))
        handler_set = handlers.get(export_id)
        operation = str(message.get("operation") or "submit")
        handler = handler_set.get(operation) if handler_set is not None else None
        if handler_set is None:
            _write_line(stdout, _failure_result(
                invocation_id,
                code="contract_violation",
                message=f"No handler is registered for export {export_id!r}.",
                retryable=False,
                request_state="rejected" if operation == "submit" else "accepted",
            ))
            continue
        if handler is None:
            _write_line(stdout, _failure_result(
                invocation_id,
                code="contract_violation",
                message=f"Export {export_id!r} does not implement {operation!r}.",
                retryable=False,
                request_state="rejected" if operation == "submit" else "accepted",
            ))
            continue
        context = ExecutablePluginContext(
            _make_host_request(invocation_id, stdin, stdout, {"value": 0})
        )
        try:
            async def invoke() -> Mapping[str, Any]:
                value = handler(message, context)
                if inspect.isawaitable(value):
                    value = await value
                return await _result_from(value, invocation_id, context, operation)

            _write_line(stdout, asyncio.run(invoke()))
        except BaseException as error:  # noqa: BLE001 — every failure must surface on the wire
            _write_line(stdout, _failure_result(
                invocation_id,
                code="execution_failed",
                message=str(error) or error.__class__.__name__,
                retryable=False,
                request_state=_request_state_for(operation),
            ))
            traceback.print_exc(file=sys.stderr)
