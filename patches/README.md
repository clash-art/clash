# OpenMA common used by Desktop

CI and Desktop packaging check out immutable common v0.5.0 commit
`08ad161ac7eb8605b6d71c825b1a8fe2d461d074` via
`.github/actions/setup-common/action.yml` and install its frozen lockfile.
Desktop Checks then runs common tests, type checks, and build. Desktop
packaging runs typecheck and build only. The pinned suite is not
Windows-compatible, and packaging does not need it.

The shared chat, composer, session controls and ACP probe/harness exports are now
in the published common release. There is no downstream source patch to apply.
The previous patch is retained only as historical candidate evidence at
`docs/validation/release-fixes-20260920/evidence/common-before-release.patch`.

For local development the existing `link:../openma-common` dependency remains.
Use the same released commit in that checkout; preserve local changes before
updating. The pre-upgrade worktree was preserved in a named common Git stash.

`@openma__common@0.5.0.patch` belongs to the separate package-manager tarball path;
it does not apply to the linked source checkout.
