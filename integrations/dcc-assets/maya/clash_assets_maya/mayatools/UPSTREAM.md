# MayaMCP source provenance

- Fork: https://github.com/clash-art/MayaMCP
- Original: https://github.com/PatrickPalmer/MayaMCP
- Imported commit: `5aa3d7b575facf699f88d5334aafa785516bb7e5`
- Imported paths: `src/mayatools/{object,scene,material}/*.py`
- License: MIT, Copyright (c) 2025 Patrick Palmer; see adjacent LICENSE.

Clash packages these native operation scripts with its Maya addon. It does not
bundle the upstream Python MCP server or its command-port transport. The existing
TypeScript Clash MCP dispatches to the session-authenticated native connection.
The native adapter derives contracts from function signatures and docstrings and
passes validated values directly to functions, without source interpolation.

Local differences:

- `scene/generate_scene.py` is excluded: this exact upstream revision has an
  orphan `elif` at line 84 (SyntaxError), missing branch code and references to
  nonexistent `thirdparty` modules. It is not advertised or packaged.
- `object/create_object.py`: handle scalar light-shape command results by resolving
  their parent transform, instead of indexing the name as a polygon result pair.
  Return-value reference: https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Tech-Docs/CommandsPython/pointLight.html
- The Clash adapter accepts JSON integers for annotated float parameters, clones
  mutable defaults and validates required/unknown parameters and primitive types.

Upstream operations remain development-preview features until exercised inside
Maya. Importing a module and testing the bridge does not verify every native API
flag or the geometry produced by its modeling recipes.

To update: compare the pinned commit with the fork, review script changes and
local differences, retain LICENSE, update this record, run integration tests and
packaging, and perform the Maya smoke checks from the parent README.
