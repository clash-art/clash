# Dependency patches

`@openma/common` is installed from the npm registry as `^0.11.0` (one version
across the workspace). The npm package's `gitHead` is the `v0.11.0` tag,
`c7ba9d66b4d80a096f816a57fb4ed4646a50609a`, the same commit CI names in
`.github/actions/setup-common/pin.env`. Its `dist/` is committed, so Clash
does not build or patch it. The historical `@openma/common@0.5.0` elicitation
patch is not applied.

CI checks out that pin, verifies the committed `dist/`, downloads the npm
tarball named in `pin.env`, checks its sha256 and compares its `dist/` with
the checkout. Clash does not run common's tests, typecheck, or build.
Upstream CI owns that suite. Desktop and web-ui resolve the published package
exports, which point at `dist/`.

The previous patch is retained only as historical candidate evidence at
`docs/validation/release-fixes-20260920/evidence/common-before-release.patch`.
