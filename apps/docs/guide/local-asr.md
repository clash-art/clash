# Local ASR & Transcripts

> Status: the native `clash.asr` bundled Generator path is delivered and can
> publish a typed `media.transcript@1` Document Asset through the generic Local
> Generator API. The synchronous legacy endpoint and Timeline transcript flow
> below remain current consumer paths and have not been rewired. See
> [Document Assets](/guide/document-assets) for the target authority.

Transcription is a first-class workflow over text-output model cards, not a
separate `ModelKind`. The cards declare an exact audio input and an `asr_model`
runtime parameter. Five built-in cards run **entirely on-device** — no provider
account, no billing, no network:

| Card                         | Local model                            | Strengths                                               |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `sensevoice-small-asr`       | `iic/SenseVoiceSmall`                  | Fast; Mandarin, Chinese-English, Cantonese              |
| `whisper-large-v3-turbo-asr` | `mlx-community/whisper-large-v3-turbo` | High-accuracy multilingual, word-level timestamps (MLX) |
| `whisper-small-asr`          | `mlx-community/whisper-small-mlx`      | Lower-memory Macs                                       |
| `parakeet-tdt-0.6b-v3-asr`   | `mlx-community/parakeet-tdt-0.6b-v3`   | 25 European languages, fast                             |
| `vibevoice-asr`              | `mlx-community/VibeVoice-ASR-4bit`     | Long-form, speaker diarization                          |

All five are ordinary `kind: "text"` cards in the same registry. The Local Host
uses their audio input contract and `asr_model` parameter to select the
on-device transcription runtime.

## Provider-route dictation

Dictation can also run through an enabled audio-capable model. The shared
`@clash/shared-runtime/cloud-project-host/voice-input` module owns readiness, the
verbatim prompt, empty-result validation and the `clash.asr.timed-transcript`
envelope. Web clients call the neutral `/api/v1/audio/voice-input` and
`/api/v1/audio/transcriptions` routes. The Cloudflare adapter serves them from
the user's hosted Provider accounts and model catalog; the Node adapter answers
them with 501 because it has no hosted text-generation runtime. The local Host
also keeps its historical `/api/v1/local/audio/*` aliases.

Local ASR install/models and the builtin RPC runtime still run only on the user's
machine. `host.localAudio` remains the capability for that setup UI, while
`host.voiceInput` reports the Provider route.

## Native migration status

The native path has landed the strict `speech.transcribe` Broker/SDK ABI, Local
broker enforcement reserved to `clash.asr`, the `clash.asr` manifest, a native
`speech-analysis` Generator Definition, its inert Action executor, and focused
schema/completed/poll tests. The Definition freezes canonical `modelId` in
Generator state, takes optional language as an Action parameter, accepts
exactly one audio/video invocation input, and declares exactly one
`media.transcript@1` Document output.

The package is registered in the closed first-party bundled-module registry;
its stdio entrypoint is compatibility packaging. The Local Host maps the
canonical model-card id to its runtime model, resolves the exact frozen media
reference, invokes the existing on-device runtime, and validates real timed
transcript output. A native end-to-end product test covers Project Generator →
ActionRun → owner-private Task → OutputCommit → Document revision.

The existing `/api/v1/local/audio/transcriptions` route, Timeline transcript
cache/editor, and other consumers still use the legacy pipeline below. Their
migration to native Generator Runs and pinned Document revisions remains a
separate product step.

## Transcript pipeline

One agent-readable path from a media asset to editable transcript artifacts:

```
asset audio/video
  → local ASR runtime (FunASR or MLX backend; word timestamps, milliseconds)
  → clash.asr.timed-transcript
  → Timeline assetTranscripts
  → GUI word-bar editing / text-cut
  → clash timeline pull
      → *.timeline.yaml       (editable source of truth)
      → *.transcript.json     (read-only word-to-frame map)
  → clash timeline apply
```

Data boundaries:

- **Raw ASR uses milliseconds** and preserves exactly what the model returned:
  stable word ids, segments, optional confidence/speaker ids, and
  backend/model/language provenance.
- **Timeline planning uses frames**: `startMs` floors, `endMs` ceils, and every
  word receives at least one frame.

## Runtime management

```sh
clash models              # includes local audio model management
```

Local model deploy/status/remove and the ASR/TTS runtimes are also scriptable
from the JS SDK (`createPythonLocalAsrRuntime`,
`createPythonLocalTtsRuntime` in `@clash/sdk`), which wrap the Python
runtime over a typed RPC surface (`LocalModelRpcInvoker`).
