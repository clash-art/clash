# OpenMA common used by Desktop

CI and Desktop packaging check out immutable common v0.5.0 commit
`08ad161ac7eb8605b6d71c825b1a8fe2d461d074` via
`.github/actions/setup-common/action.yml` and install its frozen lockfile.
That commit already contains `dist/`. The GitHub release asset
`openma-common-0.5.0.tgz` (sha256
`4f79bf81a9d73cbe15a5ed9dfdd55653c9d401e52f03077b81eaf85ed7c92dc3`) is the
same prebuilt tree. Clash checks the tarball and then uses the checkout.
It does not run common's tests, typecheck, or build. Upstream CI owns that
suite. The sibling checkout remains because Desktop and web-ui resolve
`@openma/common` to `src/` during Vite and Vitest; package exports still
point at the committed `dist/`.

The shared chat, composer, session controls and ACP probe/harness exports are now
in the published common release. There is no downstream source patch to apply.
The previous patch is retained only as historical candidate evidence at
`docs/validation/release-fixes-20260920/evidence/common-before-release.patch`.

For local development the existing `link:../openma-common` dependency remains.
Use the same released commit in that checkout; preserve local changes before
updating. The pre-upgrade worktree was preserved in a named common Git stash.

`@openma__common@0.5.0.patch` belongs to the separate package-manager tarball path;
it does not apply to the linked source checkout.
