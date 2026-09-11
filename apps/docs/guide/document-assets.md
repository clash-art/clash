# Document Assets

> Status: the typed Document Asset contracts, built-in kind registry, Project
> Loro authority, exact plugin reference/output ABI, and native Generator
> publication path are delivered. A Local Host service validates/stores bodies
> and its Local HTTP routes implement list/create/read/revision history/exact
> revision read/versioned advance/attachment operations over the live Project
> room. The native `clash.asr` Generator publishes timed transcript Documents.
> CLI/MCP exact-revision reads, Model card Document mention/picker inputs, and
> exact Document graph add/rewire/remove/copy for Models and mapped Agent Text
> Actions are
> delivered. CLI/MCP authoring, native file projections, legacy ASR consumer migration, and
> legacy metadata migration are not delivered in this snapshot.

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

The delivered built-in declarations are:

| Kind                     | Policy      | Projection     | Declared consumers                   |
| ------------------------ | ----------- | -------------- | ------------------------------------ |
| `media.transcript@1`     | `versioned` | editable JSON  | captions, transcript editing, search |
| `media.description@1`    | `versioned` | editable JSON  | search, agent context                |
| `media.render-lineage@1` | `immutable` | read-only JSON | provenance                           |

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

This is the same user-facing rule intended for projected text: read the current
revision, edit a native file projection, and apply with CAS. The Document
authority needed for that rule is delivered; a general Document checkout/apply
CLI or GUI is not.

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
CLI/MCP/GUI clients are not delivered, so this should not be presented as a
complete end-user Document authoring flow yet.

## Current Local Host service and HTTP surface

`local-document-product.ts` is a delivered Host service over the Project
authority and content-addressed body store. It:

- validates the declared `kind@schemaVersion` body before storing it;
- creates a Document, reads its head or an exact revision, and returns the
  validated body;
- lists Document heads and revision history as descriptors/body references
  without loading body content;
- advances a `versioned` head with observed-head CAS;
- creates or CAS-advances a revision-pinned attachment; and
- rejects missing or purged Media sources, missing Document revisions, and
  missing Generator revisions in `sourceRefs`.

The service stores bodies before the Project mutation, while Project Loro owns
only the immutable body reference and semantic facts. An unused body left by a
failed/stale Project CAS is unreferenced storage, not an admitted Document.

The public Local HTTP routes use the same live-room serial mutation/checkpoint
authority as native Generator writes. Create and advance derive a `user` or
`agent` producer from Host request context; callers cannot submit a producer.
Collection/history reads return descriptors and body references, while head and
exact-revision reads validate and return the body.

The service has no explicit immutable-Document COW/fork operation. That gap,
plus CLI/MCP/native file projection, prevents calling this a complete end-user
authoring surface.

## Legacy metadata boundary

Two systems currently coexist during migration:

- the native Document Asset model described here;
- the older typed metadata manifest/CAS and attachment query projection used by
  current `clash assets metadata` workflows.

The older address includes Project Asset and Action Revision targets and
remains compatibility behavior. It is not an alias for a Document Asset and
must not be used as evidence that native Document heads, revisions, or product
consumers are wired.

In particular:

- the native `clash.asr` Generator creates `media.transcript@1` Documents, but
  the current legacy ASR endpoint and Timeline transcript flow do not;
- Local HTTP human/agent authoring exists, but CLI/MCP/native file projection
  and apply are not connected in this snapshot;
- native Document deletion, trash, restore, and purge lifecycle is not defined;
- declared product consumers do not automatically wire captions, search, or
  agent context.

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
