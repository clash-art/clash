# Dependency patches

> **PENDING — do not merge while this note is here.** `@openma/common` is
> temporarily pinned to the unreleased commit
> `cd5cf3c17c770be445ee46c2e188290a678e0fee`
> ([openma-ai/openma-common#31](https://github.com/openma-ai/openma-common/pull/31),
> branch `feat/acp-headless-launch-pinned-install`). It adds the headless launch
> recipe and the pinned harness install the benchmark runner uses for Pi. Once
> the maintainer releases it as `vX.Y.Z`:
>
> 1. set `OPENMA_COMMON_SHA` and `OPENMA_COMMON_TAG` in
>    `.github/actions/setup-common/pin.env` to that release;
> 2. change every `github:openma-ai/openma-common#<sha>` manifest ref (root,
>    `apps/local-api`, `apps/web`, `apps/desktop`, `packages/web-ui`,
>    `packages/shared-artifact-evals`) to `#vX.Y.Z` and refresh `pnpm-lock.yaml`;
> 3. delete this note and restore the paragraph below to the released tag.
>
> A squash merge upstream leaves this commit on no branch, so the pin cannot be
> relied on after that PR merges.

`@openma/common` is normally installed from a release git tag (last released
pin: `v0.7.9`, `github:openma-ai/openma-common#v0.7.9`, which peels to
`afc628e5d624cc1aa61625185a1348bb87f32c05`). CI names the same commit in
`.github/actions/setup-common/pin.env`. Its `dist/` is committed, so Clash
does not build or patch it. The historical `@openma/common@0.5.0` elicitation
patch is not applied.

CI checks out that pin and verifies the committed `dist/`. With a release tag
it also checks that the tag peels to the pinned commit; with an empty
`OPENMA_COMMON_TAG` (the temporary state above) it prints a warning instead.
v0.7.9 publishes no GitHub release tarball, so both tarball fields stay empty.
When a release asset exists, set the URL and sha256 together and CI compares
that archive to the checkout. Clash does not run common's tests, typecheck, or
build. Upstream CI owns that suite. Desktop and web-ui resolve the published
package exports, which point at `dist/`.

The previous patch is retained only as historical candidate evidence at
`docs/validation/release-fixes-20260920/evidence/common-before-release.patch`.
