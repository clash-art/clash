# Dependency patches

`@openma/common` is installed from the git tag `v0.7.7`
(`github:openma-ai/openma-common#v0.7.7`). That tag peels to
`95524fc1cbdd4d99edbd5b2954c224a57119f10f`, the same commit CI names in
`.github/actions/setup-common/pin.env`. Its `dist/` is committed, so Clash
does not build or patch it. The historical `@openma/common@0.5.0` elicitation
patch is not applied.

CI checks out that pin and verifies the committed `dist/`. v0.7.7 publishes
no GitHub release tarball, so both tarball fields stay empty. When a release
asset exists, set the URL and sha256 together and CI compares that archive
to the checkout. Clash does not run common's tests, typecheck, or build.
Upstream CI owns that suite. Desktop and web-ui resolve the published package
exports, which point at `dist/`.

The previous patch is retained only as historical candidate evidence at
`docs/validation/release-fixes-20260920/evidence/common-before-release.patch`.
