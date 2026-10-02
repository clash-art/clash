# Dependency patches

`@openma/common` is installed from the git tag `v0.6.0`
(`github:openma-ai/openma-common#v0.6.0`). That release already includes the
elicitation client callback that the historical `@openma/common@0.5.0` patch
added, and its `dist/` is committed, so Clash does not build or patch it.

The previous patch is retained only as historical candidate evidence at
`docs/validation/release-fixes-20260920/evidence/common-before-release.patch`.
