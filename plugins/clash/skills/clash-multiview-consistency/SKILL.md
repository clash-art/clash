---
name: clash-multiview-consistency
description: "Create or repair consistent views of one subject: character turnarounds, product angles, prop sheets, vehicles, creatures, or room views. Use for 三视图、多角度一致性 and unseen-side design."
---

# Multiview consistency

Produce different views of **one selected design**. This skill ends at a reviewed
view set and reusable prompts; it does not require a story, video, or Timeline.
Use existing authorized image tools and the user's chosen model/provider.
In a Clash Project, follow the base `clash` skill's Generator and Asset contracts
for execution and retain its selected input revisions and output identities.

## Define the view change

Separate **invariants** (identity, proportions, construction, materials, markings)
from **variables** (camera position, pose, lighting, or object state). Change only
what this task requests. A new angle is not a new design or colorway.

Choose views that expose the needed information. “Three views” is not always
front/profile/back: a product may need front/side/top; a creature may need both
sides to resolve asymmetric markings. A room needs camera positions tied to a
plan, not three rotations of the same flat background.

Distinguish an orthographic design sheet from photographic perspective views.
Specify the projection when it matters. Neither generated orthographic-looking
images nor a turnaround sheet establish dimensionally accurate CAD geometry.

## Use an anchor, then derive views

Start from a selected image or user-provided design. Inspect which details it
actually establishes. Attach that image through a supported reference/edit input
when generating another view. Repeated adjectives or a shared seed alone do not
establish identity. Compare every candidate against the anchor and accepted
views; do not propagate drift by referring only to the last generated image.

If reference delivery fails, repair the input through the supported contract.
Do not drop the image and silently treat a text-only request as equivalent
identity control. Report any remaining limitation before claiming consistency.

Keep scale, camera height, pose, illumination, and background comparable when
making a design sheet. For environments, record fixed world relationships such
as doors, windows, furniture, and light sources; derive what the new camera sees.
Mirroring an image reverses asymmetric details and is not a reverse-angle view.

An unseen surface is unknown. For an existing product or real location, use
additional supplied evidence when needed; label invented details as unresolved.
For original design work, propose the missing side and review it before adding
it to the selected design. Do not claim to recover a hidden logo or mechanism.

## Write the prompt as a constrained change

Use the following structure, replacing the brackets with observed details.
The reference names must correspond to images actually attached to the request;
translate them to the selected tool's supported reference syntax.

```text
Reference A is the selected [subject] design. Reference B, if supplied, is its
accepted [other view]; both show the same subject.
Create [requested view / camera position] of that same subject.
Preserve [specific proportions, shapes, construction, materials, markings,
and asymmetric details established by the references].
Change only [viewpoint and any explicitly requested pose/state/lighting].
Use [projection, framing, scale, background, lighting appropriate to the task].
For [unseen region], follow [additional evidence or selected design decision].
Deliver [one isolated view or the requested sheet layout].
```

Useful substitutions across categories:

| Subject                       | Invariants worth spelling out                                                                     | View-specific request                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Person or stylized character  | Jaw/nose silhouette, hair length, body ratios, collar, closures, footwear, asymmetric accessories | Left profile with comparable pose and full-body scale; later derive the back                   |
| Appliance or packaged product | Body proportions, seams, controls, handle attachment, material finish, supplied artwork           | Rear three-quarter view; preserve the actual hinge side and keep the lid in its selected state |
| Creature or vehicle           | Limb/wheel layout, silhouette, markings, joint placement, directional details                     | Opposite side without mirroring asymmetric markings or controls                                |
| Interior or set               | Openings, furniture adjacency, circulation, fixed light positions                                 | Camera behind the counter facing the entrance, consistent with the supplied plan               |

For precise packaging text, bind supplied artwork or use an appropriate controlled
editing step. Reject plausible-looking replacement typography as a design match.

## Accept, repair, and hand off

Compare silhouettes, landmark proportions, construction, materials, and
asymmetry across views. For a room, reconcile topology and camera positions.
Do not reject a justified perspective or illumination change as identity drift.

When one region fails, retain the selected references and correct that region
or view. State the concrete mismatch in the repair prompt; repeating “more
consistent” gives the model little new information. Record any intentional
design revision so incompatible variants do not enter one reference set.

Keep individual accepted views and their source identities, plus a review sheet
when useful. Label unresolved areas and alternatives. A sheet is for comparison;
use an individual view or a newly composed image for a single-scene video start
frame. The deliverable establishes reviewed visual agreement, not guaranteed
3D reconstruction or future shot consistency.

## Sources

Clash-authored generalization of reference workflows; no upstream skill is
vendored here. The cross-category prompt structure above is a working method,
not a provider-guaranteed control.

- [Runway: longer videos and films](https://help.runwayml.com/hc/en-us/articles/26871350018835-How-to-create-longer-videos-and-films) — character and environment plates.
- [Runway: image references](https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References) — reference reuse and iterative view creation.
