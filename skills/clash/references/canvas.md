# Canvas and generation

Canvas arranges Project content. A Model or Action card is a placement of a
Project Generator; its `generatorId` selects the same authored Revision used by
the Generator API. Canvas is not a separate generation authority.

## Read the current placement

```bash
clash canvas list --project <id> --json
clash canvas get --project <id> --node <node-id> --json
clash canvas edges --project <id> --json
```

Read before changing an existing node. The CLI records observations implicitly.
A referenced node is immutable as a whole: use `clash canvas copy` to preserve
existing downstream references, then explicitly rewire the intended consumers.
Groups organize drafts; membership alone does not supply a generation input.

| Project content | Canvas relationship |
| --- | --- |
| Generator | A card places its identity; edits advance the same Generator Revision. |
| Media Asset | Image, video, audio or model nodes reference the immutable Project Asset. |
| Text Document | Applied text references an exact Document Asset revision; editable draft text must be applied before it is used as that reference. |
| Timeline | The editor operates the Project Timeline; rendered output pins its revision. |
| Group | An organizational container, not an implicit prompt or an execution engine. |

## Author and execute the same Generator

1. Read the live Generator Definition and the selected Model Card. For a
   Model, `clash.model-generation` supplies the Definition for the output kind;
   the Model supplies capabilities, supported inputs and parameter values.
2. For an existing card, read its `generatorId` and advance that Generator.
   For a new draft, create a Generator with `placement` to create the card
   atomically. Consult `clash generators contract create` or `advance` for the
   request shape. Do not write a second prompt/model/parameter state into Canvas.
3. Provide explicit input references and ordered content parts. Preserve each
   input's slot, occurrence and exact Asset revision. An existing Document
   reference includes `documentAssetId` and `revisionId`; use its saved revision
   even if the Document head later advances. Image reorder changes which image
   occupies a time position; it must not reset custom keyframe timing. Replacing
   a reference in place retains its role and timing.
4. Submit the Action against the exact Revision. If the user selected Hilo or
   another Provider, pass its configured `providerAccountId` in submission
   input. Provider routing does not belong in authored Model state.
5. Poll the returned Action Run until terminal, then read its Output Commit.
   Use the committed Asset for subsequent generation or Timeline editing.

The command sequence is documented in [commands.md](commands.md). CLI and MCP
operate these same facts. Adding a group, prompt or card is not evidence of a
finished generation. A pending Canvas result is a projection of the background
Run, not a completed Asset. An existing output placement may be deleted or
rewired without changing the immutable Run and Output Commit.

For local-agent text, use the shipped `clash.agent-text` / `text` Definition and
its Agent Text Action Card. This is a configured agent session, not a Model
Provider route. It commits an exact text Document revision through the same
Generator lifecycle. Read that body with `clash assets documents get
<documentAssetId> --revision <revisionId>`.
