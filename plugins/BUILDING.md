# Plugin build outputs

The `runtime/` directories in `clash`, `clash-director`, and `clash-timeline`
are generated distributions. They contain compiled JavaScript, declarations,
browser bundles, and copied runtime resources. Keep their source inputs in Git;
do not commit these output directories or edit generated files.

After a fresh checkout, build the distribution before running its packaged
entrypoints or installing a plugin directly from the checkout:

```sh
pnpm install --frozen-lockfile
pnpm build:package clash
```

Use `pnpm test:package clash` for artifact-dependent tests: the root Turbo test
task depends on the package build. Direct package-level test commands assume
matching build outputs already exist. Source development uses `pnpm clash:dev`.

The npm beta workflow builds before publishing, and desktop packaging builds
before assembling its runtime. Package manifests explicitly include `runtime`
in their `files` lists, so Git ignores do not remove these outputs from release
packages. A source checkout alone is not a prebuilt plugin distribution.
