# Document Assets

> Status: the typed Document Asset contracts, built-in kind registry, Project
> Loro authority, exact plugin reference/output ABI, and native Generator
> publication path are delivered. A Local Host service validates/stores bodies
> and its Local HTTP routes implement list/create/read/revision history/exact
> revision read/versioned advance/attachment operations over the live Project
> room. The native `clash.asr` Generator publishes timed transcript Documents.
> CLI/MCP exact-revision reads, Model card Document mention/picker inputs, and
> exact Document graph add/rewire/remove/copy for Models and mapped Agent Text
> Actions are delivered. CLI native Document create/read/history/copy/attachments
> and pull/edit/apply now use the Local Host authority with implicit observations.
> Project content list/search/read shares the existing Media and exact Document
> references across CLI, MCP, and Local HTTP.
> General MCP Document authoring, legacy ASR consumer migration, and automatic legacy metadata
> migration remain outside the delivered boundary.

A **Document Asset** is structured, typed product content with a stable head
over immutable revisions. Examples include a timed transcript, a media
description, and a render-lineage record.

Use “Document” for this content rather than overloading “metadata.” Descriptive
facts such as media dimensions, duration, codecs, content type, and display
name remain Media Asset metadata. A transcript or analysis body has its own
schema, producer, lineage, revision identity, and consumers, so it is an Asset
in its own right.

## Identity and storage boundary

| Concept                     | Meaning                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Project Document Asset head | Stable identity with one mutable `headRevisionId` pointer                                                                         |
| Document revision           | Immutable fact containing kind, schema version, mutability policy, lineage, body reference, producer, and exact source references |
| Document body reference     | Storage-free `{ digest, byteLength, contentType }` address                                                                        |
| Document attachment         | Relation from a product target and slot to one exact Document revision                                                            |

Project Loro owns heads, immutable revision facts, and attachment relations. It
does not store a local path, database row id, bucket key, signed URL, or body
bytes. The current Local body store still uses the historical
`metadata-blobs` implementation name; that transport name is not the domain
model.

Every revision records one producer:

- an `action-run` that materialized it;
- an actor of kind `user` or `agent`;
- an explicit migration source.

`sourceRefs` use the same exact Media, Document-revision, and
Generator-revision references as Generator inputs. Provenance therefore does
not depend on a mutable head or an execution-time URL.

## Kind registry

A Document kind declaration fixes the kind name, schema version, head
mutability, projection format/editability, allowed attachment target kinds,
and the standard product consumers that understand it. An empty consumer list
means storage/projection support only; it grants no implicit product behavior.

The delivered built-in declarations include:

| Kind                     | Policy      | Projection     | Declared consumers                   |
| ------------------------ | ----------- | -------------- | ------------------------------------ |
| `text.plain@1`           | `versioned` | editable text  | search                               |
| `media.transcript@1`     | `versioned` | editable JSON  | captions, transcript editing, search |
| `media.description@1`    | `versioned` | editable JSON  | search, agent context                |
| `media.render-lineage@1` | `immutable` | read-only JSON | provenance                           |
| `media.operation-trace@1` | `immutable` | read-only JSON | provenance, search, agent context |
| `media.observation@1` | `versioned` | editable JSON | search, agent context |

The registry can accept additional declarations in code. There is not yet a
plugin contribution artifact or Host loader for third-party Document kinds, so
the registry API alone must not be described as an installed-plugin feature.
Project authority rejects a revision whose `kind@schemaVersion` is undeclared
or whose revision mutability differs from that declaration.

## Versioning, CAS, and copy-on-write

Document bodies and revisions never change in place. Mutability describes only
what may happen to the stable head:

- a `versioned` Document may append a revision whose `parentRevisionId` equals
  the observed head, then advance that head by compare-and-set;
- an `immutable` Document cannot advance; an edit must create another Document
  Asset with explicit `forkedFrom` lineage.

A stale observed head fails with `STALE_DOCUMENT_HEAD`. Reusing a revision id
for different immutable facts fails. The authority treats an identical replay
as idempotent. Existing Generator inputs, Run inputs, attachments, and output
commits remain pinned to the exact older revision until explicitly rewired.

The CLI implements this through `documents pull`, native file edits, and
`documents apply`. Each file retains its original observed revision and Host
receipt in `.clash/observed.json`; a later `get` or another file's successful
apply cannot refresh that draft's baseline. A dirty file is never overwritten
by pull. Reconcile against a fresh file, then apply from its observed baseline.
An unchanged `documents copy` creates a new Asset with `forkedFrom` pointing to
the selected exact revision. Existing references and attachments remain on the
source. A kind with `projection.editable: false` permits reads and unchanged
copies, but the CLI refuses native editing; copying does not bypass that policy.

## Attachments

An attachment is a relation, not the Document payload. It has a stable id, a
slot, a target, and an exact Document revision reference. The current target
union is:

- Project Media Asset;
- Generator Revision;
- Action Run.

The Project authority verifies the referenced Document revision, applies
attachment insert-or-compare/CAS rules, and enforces the kind declaration's
`allowedAttachmentTargets`. It also requires the target to exist: a Project
Media Asset must be real and not purged, a Generator Revision must be readable,
and an Action Run must be present. These are attachment-admission checks; they
do not make the attachment collection a Document body store or wire any
declared product consumer.

## Generator and plugin ABI

A Generator port may require an exact `{ documentKind, schemaVersion }`. A Run
then pins a specific `{ documentAssetId, revisionId }` for that slot.

At the executable-plugin boundary:

- a frozen Document reference includes the exact Asset/revision id, kind, and
  schema version;
- `context.reference` resolves it as `form: "document"` with the validated
  body;
- an executor returns a Document output in its declared slot with kind, schema
  version, and body;
- the native Generator bridge validates the output contract, installs the body,
  publishes the immutable revision and Output Commit, and only then publishes
  Run success.

The same invocation/result ABI is used by bundled first-party modules and
process/stdio plugins. Execution realm is not stored in a Document revision or
Run.

The ABI, publication bridge, and Local HTTP compiler from validated Generator
state/references to a native invocation are delivered. The Local Generator API
also supports observed-head advancement and the explicit-create COW path.
Native Document CLI authoring is delivered separately below. General MCP Document authoring and
a general Document GUI editor are not implied by these Generator APIs.

## Current Local Host service and HTTP surface

`local-document-product.ts` is a delivered Host service over the Project
authority and content-addressed body store. It:

- validates the declared `kind@schemaVersion` body before storing it;
- creates a Document, reads its head or an exact revision, and returns the
  validated body;
- lists Document heads and revision history as descriptors/body references
  without loading body content;
- advances a `versioned` head with observed-head CAS and copies exact revisions
  into a new Asset with existing `forkedFrom` lineage;
- creates or CAS-advances a revision-pinned attachment; and
- rejects missing or purged Media sources, missing Document revisions, and
  missing Generator revisions in `sourceRefs`.

The service stores bodies before the Project mutation, while Project Loro owns
only the immutable body reference and semantic facts. An unused body left by a
failed/stale Project CAS is unreferenced storage, not an admitted Document.

The public Local HTTP routes in `local-document-routes.ts` use the same live-room serial mutation/checkpoint
authority as native Generator writes. Create and advance derive a `user` or
`agent` producer from Host request context; callers cannot submit a producer.
Collection/history reads return descriptors and body references, while head and
exact-revision reads validate and return the body.

Agent mutations require Host-signed observation evidence in internal HTTP
headers. CLI and MCP output omit these protocol fields without altering fields
inside the Document body. CLI transport uses the normal Host discovery and
`apiFetch`; an unavailable Host fails the operation and never writes a legacy
manifest as a fallback.

## Delivered CLI workflow

All commands below are under `clash assets documents`; project identity is
resolved from the working-tree marker (or `--project` for explicit reads).

```bash
clash assets documents kinds --json
clash assets documents create --kind text.plain --file script.txt
clash assets documents list --json
clash assets documents get <document-id>
clash assets documents history <document-id>
clash assets documents get <document-id> --revision <revision-id>
clash assets documents pull <document-id> --file draft.txt
# edit draft.txt with native tools
clash assets documents apply <document-id> --file draft.txt
clash assets documents copy <document-id> --revision <previously-read-revision-id>
```

`create` accepts `--schema-version` and an optional `--source-refs` JSON file of
exact shared input references. Body files follow the kind's declared projection:
`text.plain` is plain text; transcript/description bodies are JSON validated by
the Host kind registry. Relative paths are relative to the invoking directory;
pull/apply files must remain inside the linked working tree. Successful entity
reads record internal observations. Apply, copy, and attachment changes require
the relevant prior observation; there is no public token, force, or manual CAS
flag. Immutable revisions remain readable after head advancement and Host
restart.

`attachments` lists relations; `attachment <id>` reads one. After reading the
exact Document revision, `attach <document-id> --revision <revision-id>
--target target.json --slot <slot>` creates a relation. The target JSON follows
the shared target union above, for example
`{"kind":"project-asset","projectAssetId":"<media-id>"}`.
`advance-attachment <attachment-id> --revision <previously-read-revision-id>`
requires observations of both the attachment and destination revision, and
advances only within the same Document Asset. It checks the full current
attachment inside the serial Host mutation. Cross-Document in-place reattach
is not supported: explicitly attach a copied Document as a new relation;
existing attachments and downstream inputs are preserved.

## Browse, search, and read Project content

Start with an overview, search when a name or phrase is known, then read the
exact reference returned by either operation:

```bash
clash ls --json
clash ls --kind video --limit 100 --json
clash search "folding clothes" --kind video --json
# Pass an items[].ref or matches[].document object from the result verbatim.
clash read '{"kind":"document","documentAssetId":"<id>","revisionId":"<revision>"}' --json
clash search "left sleeve" --within '{"kind":"media","projectAssetId":"<id>"}' --json
```

These top-level commands resolve the Project from the working-tree marker, or
accept `--project <id>`. `ls` returns active Media Assets and current Document
heads as `items` with `ref`, `name`, `kind`, lightweight `info`, and empty
`matches`. It does not load Document bodies. Supported kind filters are
`image`, `video`, `audio`, `model`, and `document`.

`search` matches names and declared human-readable Document fields using
Unicode-normalized, case-insensitive literal text. It reads searchable
Documents directly and the exact searchable Document revisions attached to
Media Assets. This includes plain text, descriptions, transcripts, supported
media-analysis prose, observations, and operation records. It does not search
serialized metadata or provide embeddings, semantic ranking, or inferred
descriptions of unanalysed media. Documents currently use their Asset identity
as the listed name; body text is searched separately.

A content match includes the matching text, exact `document` reference,
`documentKind`, producer, and source references; attached evidence also carries
its attachment identity. If evidence contains a valid time range and identifies
one source video or audio Asset, `location` names that source Asset and its
`startMs`/`endMs`. A source time range is never reassigned to an output merely
because the evidence is attached there. Advancing a Document head does not
advance an attachment's pinned revision.

`read` reuses the existing Media read or exact Document-revision read authority.
A Media read returns its descriptor and delivery information; a Document read
returns the validated body and provenance at the supplied revision. It does not
follow a newer head. `search --within` accepts the same reference, including a
historical Document revision. These are existing `AssetRevisionRef` objects,
not filesystem paths, a virtual filesystem, or a new reference format.

List and search return up to 50 items by default; `--limit` accepts 1–200.
`countsByKind` always includes `image`, `video`, `audio`, `model`, and `document`,
with zero for absent kinds. It counts unique objects matching the Project,
query, and `within` scope before applying the kind filter or result limit;
multiple matching fragments in one object count once. List computes these
counts from overview facts without reading Document bodies.
`truncated: true` means another page exists. Repeat the same query, kind and
`within` scope with `--cursor '<nextCursor>'` until `nextCursor` is null. The
limit may change between pages. Cursors bind to the Project, operation, filters
and matching results. If these change, `CONTENT_CURSOR_STALE` (409) asks the
caller to restart without the cursor; malformed cursors return 400. Unrelated
Project edits do not invalidate unchanged results. Counts describe the full
matching set, not the remaining page.
`matchMode` is `null` for list and `"literal-text"` for search. Results remain
inside the selected Project and exclude inactive Media Assets.

The Local Host exposes `GET /api/v1/projects/:projectId/content` for list
(`kinds` as a comma-separated filter and optional `query`, `limit`, `cursor`) and `POST` on the
same path for search (`query`, `kinds`, `within`, `limit`, and `cursor` in JSON). Reading
still uses the existing Media and Document routes. MCP exposes
`content_list`, `content_search`, and `content_read` on the Assets dispatcher;
MCP passes `within` and `ref` as objects rather than CLI JSON strings. CLI and
MCP reuse the shared Project content client.

## External observations and processing records

External work can use the existing Document authority without inventing a
successful Action Run. `clash actions observe --asset <id> --file <json-file>`
stores a `media.observation@1` body with `summary`, optional `tool`/`model`, and
optional `observations` entries containing `text` and paired source
`startMs`/`endMs`. The revision's Host-derived actor and exact source reference
identify who recorded it and which Asset it describes.

`clash actions record --source <ids...> --output <ids...> --title <text>
--detail-file <path>` stores `media.operation-trace@1`: an immutable
`{title, detail}` body, source/output Asset references in revision `sourceRefs`,
and attachments to the imported output Assets. Use `--detail` instead of
`--detail-file` for inline notes. This is a record of external execution;
its detail is never run, and it is not an executable custom Action. Project
custom Actions use the [native invocation path](/guide/asset-generator-model#task-oriented-action-invocation).

Both conveniences use create, exact-revision read and attach. They return a
`recordId`, exact Document reference and attachments. A supplied `--record-id`
can replay identical content after an interrupted save; failures with an
automatically allocated ID expose it for recovery too. Changed replay content
fails instead of overwriting history. MCP provides the same scoped operations
as `record_operation` and `record_observation` on the Assets dispatcher;
general-purpose Document authoring is a separate capability.

The narrower compatibility command `clash assets search [query]
--asset <optional-asset-id>` remains available for attached native evidence.
Use the Project content workflow above to browse or search both Media Assets
and Documents, then read the exact returned reference. Both search surfaces
preserve attachment revision identity and use declared prose rather than
serialized metadata.

## Legacy metadata boundary

Two systems currently coexist during migration:

- the native Document Asset model described here;
- historical typed metadata manifests and the old attachment query index,
  retained for deliberate compatibility reads.

The older address includes Project Asset and Action Revision targets and
remains compatibility behavior. It is not an alias for a Document Asset and
must not be used as evidence that native Document heads, revisions, or product
consumers are wired.

In particular:

- the native `clash.asr` Generator creates `media.transcript@1` Documents, but
  the current legacy ASR endpoint and Timeline transcript flow do not;
- `clash assets metadata set/apply`, `projection --kind metadata:*`, and
  `PUT /api/v1/local/asset-metadata` are retired with explicit replacement
  guidance; the HTTP writer returns 410;
- `assets metadata list/get/kinds/validate`, the historical index GET, and old
  Timeline transcript body reads remain available;
- CLI Document authoring and scoped MCP external-record/observation authoring are connected; general MCP Document authoring remains unimplemented;
- native Document deletion, trash, restore, and purge lifecycle is not defined;
- declared product consumers do not automatically wire every UI or agent-context
  surface; the explicit content reader above searches supported Document fields
  and revision-pinned attachments.

No manifest is automatically imported, replaced, or made authoritative. A user
can read/export a legacy body, validate it against an appropriate native kind,
then explicitly create a new Document and attachment with its source references.
Arbitrary descriptive metadata is not automatically a valid Document body.
Migration should create explicit Document revisions and attachments, preserve
source/provenance facts, and move each consumer deliberately. It must not
silently reinterpret an old metadata row as a delivered native workflow.

## Invariants

1. A Document head is stable; every body and revision is immutable.
2. Every reference, attachment, and Generator input pins an exact revision.
3. Kind and schema version are validated before executor access or output
   publication.
4. `versioned` means CAS head advancement, not mutable revision bytes.
5. `immutable` edits use copy-on-write and explicit lineage.
6. Body storage locations never enter Project authority.
7. Descriptive Media Asset metadata is not a Document Asset.
8. Registry declarations do not imply product integration that has not been
   wired.
