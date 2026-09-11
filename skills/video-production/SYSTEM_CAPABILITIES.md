# Video Production System Capabilities

Clash-native product capabilities available to skills. A skill owns workflow
instructions, artifact contracts, QA criteria, and license constraints. Clash
owns collaboration and management: asset registration, declared metadata,
provenance, timeline CAS apply, and canvas/timeline projections.

Anything not listed here is skill-owned: write it as declarative JSON in the
working tree and check it yourself.

## Available

- `media.metadata-registry`: declared asset metadata kinds. `media.transcript`
  and `media.description` ship built in; a workspace declares its own under
  `.clash/metadata-kinds/*.json` with a JSON Schema that pins `kind` and
  `schemaVersion`. An undeclared kind is refused everywhere.
- `media.analysis-store`: native Document heads/revisions and attachments belong
  to the Project authority; verified immutable bodies use the Host body store.
  Historical manifest metadata and `GET /api/v1/local/asset-metadata` remain
  read-only compatibility. Public legacy index writes are retired.
- `media.transcript`: the native ASR Generator publishes a timed transcript
  Document. Legacy ASR HTTP and Timeline transcript consumers retain their
  existing grid/body reads; consumer migration is not automatic.
- `document.native-edit`: `clash assets documents create/get/pull/apply/copy`
  uses the live Host and file-specific implicit observations. The declared kind
  chooses text or JSON and whether editing is supported. Stale edits fail;
  copies preserve source lineage and existing attachments. Use explicit
  `documents attach` and same-Document `advance-attachment` for relations.
  Legacy metadata set/apply and metadata projections report retirement errors.
- `render.remotion-composition`: Canvas `remotion-component` nodes hold editable
  default-exported Remotion TSX; Timeline `composition` items bind the Canvas
  identity through `sourceNodeId`; a completed Timeline render creates the
  playable product Asset and receipt.
- `timeline.cas-projection`: timeline/text pull-edit-apply with implicit CAS.
- `audio.local-asr-install`: `clash models local catalog/status/install` reads
  the same model cards as the GUI, resolves card ids to runtime ids, and
  installs Whisper/SenseVoice/Parakeet class models through the product path.

## Partial

- `media.asset-registry`: asset rows, refs, and blob storage exist; consistent
  path-ownership checks across every media workflow are still incomplete.
- `render.export-validation`: render receipts and playable final Assets exist;
  loudness, OCR/logo, and broader referenced-media validation remain missing.
