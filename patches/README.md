# OpenMA common used by Desktop

CI and Desktop packaging read the OpenMA pin from
`.github/actions/setup-common/pin.env` (currently v0.7.1 commit
`5d839b5cbf7170ced4cb031d45c0e6e4261ca175`) and install its frozen lockfile.
Change that file alone to move the pin. v0.7.1 publishes no GitHub release
tarball, so both tarball fields stay empty and CI checks that `dist/` is in
the tagged commit. When a release asset exists, set the URL and sha256
together and CI compares that archive to the checkout. Clash does not run
common's tests, typecheck, or build. Upstream CI owns that suite. The sibling
checkout remains because Desktop and web-ui resolve `@openma/common` to
`src/` during Vite and Vitest; package exports still point at the committed
`dist/`.

The shared chat, composer, session controls and ACP probe/harness exports are now
in the published common release. There is no downstream source patch to apply.
The previous patch is retained only as historical candidate evidence at
`docs/validation/release-fixes-20260920/evidence/common-before-release.patch`.

For local development the existing `link:../openma-common` dependency remains.
Use the same released commit in that checkout; preserve local changes before
updating. The pre-upgrade worktree was preserved in a named common Git stash.

`@openma__common@0.5.0.patch` belongs to the separate package-manager tarball path;
it does not apply to the linked source checkout.
