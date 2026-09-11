---
name: clash-reference-composition
description: "Compose or edit an image using explicit subject, environment, style, and layout references. Use when combining references must preserve selected identities while changing the composition, including product scenes, illustration, and shot keyframes."
---

# Reference composition

Create one composition from selected inputs, making each reference's role
explicit. This applies to product imagery, posters, illustrations, environments,
and film keyframes; no film workflow is required.

## Assign roles before writing the prompt

Identify what each image controls: **subject identity**, **environment**,
**material/style**, or **layout/pose**. The same input may serve several roles,
but a background or pose embedded in an identity reference need not be copied.
Resolve conflicting selected designs before generation. Attach only relevant
inputs within the chosen model's actual reference limits.

Use existing authorized tools and honor the requested model/provider. Bind
actual images through supported reference/edit slots. A filename in prose is
not an attachment. Check the current model contract rather than assuming every
image input has the same effect.
In a Clash Project, follow the base `clash` skill's Generator and Asset contracts
for execution and retain its selected input revisions and output identities.
Repair failed reference delivery instead of silently dropping an identity or
exact-artwork input. Describing style in words is appropriate for a style-only
role, but does not establish equivalent identity control.

## Describe the intended image, then constrain the change

```text
Create [target composition, camera/framing, placement, action or presentation].
Reference A controls [subject identity and its concrete invariant details].
Reference B controls [environment/material/style and relevant invariant details].
Reference C, if supplied, controls [layout/pose only].
Preserve [specific features that must survive the composition change].
Change [explicitly permitted background, viewpoint, pose, lighting or state].
Keep [scale, contact, occlusion, light direction and spatial relationships]
coherent in the resulting image.
Deliver [the requested single image or edit, without unintended sheet framing].
```

Map A/B/C to actual attachments and the model's reference syntax. For example,
a backpack photograph can control stitching and closures while a layout sketch
controls its position on a chair. The source photograph's studio floor should
not silently replace the requested room. For a repair, identify the region that
changes and the surrounding features that should remain; use a supported mask
when appropriate instead of claiming an unavailable mask was applied.

## Keep reference and frame roles distinct

- A subject/style reference guides selected qualities when supported.
- An image-to-video start frame determines the opening composition. Compose
  the intended close-up first if the available image shows a wide view.
- A supported end frame constrains the destination; it does not prove the
  generated motion between the frames is valid.
- An accepted ending frame may support a continuous extension. A new camera
  needs a new composition rather than the previous camera's frame reused blindly.

A multiview sheet can help review identity, but a video start-frame slot may
animate the sheet or multiple copies. Select the needed view(s) and compose the
intended single scene separately. If a needed angle is missing, use the
available `clash-multiview-consistency` skill for that gap only.

## Review the result by role

Check identity against its anchor, layout against the intended composition,
and materials/lighting against their selected references. Inspect scale,
contact, occlusion, and important text as part of the combined image. A result
can match each reference superficially while placing the object impossibly.

Repair the failed role or its reference selection; keep accepted roles stable.
Preserve selected input identities and the generated result so later work can
reuse the actual selection. Deliver the composed image and any unresolved
mismatch, without treating a successful generation request as visual acceptance.

## Sources

Clash-authored workflow and prompt template informed by:

- [Runway: image references](https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References).
- [Google: video generation](https://ai.google.dev/gemini-api/docs/video) — distinct reference-image and first/last-frame workflows; availability depends on the selected route.
