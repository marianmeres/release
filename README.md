# @marianmeres/deno-release

> ## ⚠ Renamed to [`@marianmeres/release`](https://jsr.io/@marianmeres/release)
>
> This is the **final release under the `deno-release` name** — the name became
> inaccurate once the tool learned to release npm projects too. This version is
> feature-complete and will keep working indefinitely, but all future
> development happens under the new name.
>
> To migrate, change your task to:
>
> ```bash
> deno run -A jsr:@marianmeres/release
> ```

An opinionated, interactive CLI tool for releasing Deno / JSR / npm projects.
Bumps the version in `deno.json` (or `jsr.json`, or `package.json`), creates an
annotated git tag, and pushes the commit together with the new tag to the remote
repository.

## Features

- Semantic versioning (`major`, `minor`, `patch`)
- Interactive confirmation before making changes
- Non-interactive mode with `--yes` flag for CI/CD pipelines
- `--dry-run` mode to preview actions without touching anything
- `--verbose` mode for diagnostic command logging
- Supports `deno.json`, `jsr.json` and `package.json` manifests
- Keeps `package-lock.json` in sync on npm releases (so `npm ci` keeps working)
- Preserves the original indentation of the manifest file
- Validates clean git state (no uncommitted changes)
- Warns when not on `main`/`master` branch
- Pre-flight checks: tag does not already exist, `origin` remote is configured
- Pushes only the newly created tag (not all local tags)
- Creates annotated git tags with an optional custom message
- Zero runtime dependencies

## Usage

### Via `deno run`

```bash
# Patch release (1.0.0 -> 1.0.1)
deno run -A jsr:@marianmeres/deno-release patch

# Minor release (1.0.0 -> 1.1.0)
deno run -A jsr:@marianmeres/deno-release minor

# Major release (1.0.0 -> 2.0.0)
deno run -A jsr:@marianmeres/deno-release major

# With custom message
deno run -A jsr:@marianmeres/deno-release patch "Fixed critical bug"

# Skip confirmation prompts (useful for CI/CD)
deno run -A jsr:@marianmeres/deno-release --yes patch
deno run -A jsr:@marianmeres/deno-release -y minor "New feature"

# Preview without making changes
deno run -A jsr:@marianmeres/deno-release --dry-run minor
deno run -A jsr:@marianmeres/deno-release -n patch

# Log each git command that is executed
deno run -A jsr:@marianmeres/deno-release --verbose patch
```

Flags can appear anywhere in the argument list.

### As a Deno task

Add to your `deno.json`:

```json
{
  "tasks": {
    "release": "deno run -A jsr:@marianmeres/deno-release"
  }
}
```

Then run:

```bash
deno task release patch
deno task release minor "Added new feature"
deno task release --dry-run minor
```

### Install globally

```bash
deno install -A -g -n release jsr:@marianmeres/deno-release
```

Then use anywhere:

```bash
release patch
release minor "New feature"
release --yes patch   # non-interactive
release --dry-run     # preview only
```

### npm projects

A repo with only a `package.json` works the same way — there is nothing to
configure:

```json
{
  "scripts": {
    "release": "deno run -A jsr:@marianmeres/deno-release"
  }
}
```

```bash
npm run release -- patch
npm run release -- minor "Added new feature"
```

The tool never publishes to npm; it only bumps, commits, tags and pushes, so
`"private": true` packages are fine.

## Manifest resolution

The manifest is the first of `deno.json`, `jsr.json`, `package.json` that
exists **and** carries a string `version` field. Candidates without a `version`
are skipped, so a `deno.json` kept purely for tasks / imports next to a
versioned `package.json` resolves to the `package.json`.

When more than one candidate is present, the chosen one is printed together
with a note listing the others (which are *not* updated).

## Lockfiles

When the resolved manifest is a `package.json` and a `package-lock.json` sits
next to it, the lockfile's root version is synced in the same commit. This is
not cosmetic: `npm ci` refuses to run when the lockfile disagrees with
`package.json`, so bumping the manifest alone would break CI.

- The lockfile is patched directly (both `version` and, for lockfileVersion
  2 / 3, `packages[""].version`) — no `npm` binary, `node_modules` or network
  access is needed.
- Only fields that already exist are updated; nothing is invented.
- Indentation and trailing newline are preserved, exactly as for the manifest.
- An unparseable lockfile fails **pre-flight**, before anything is mutated.
- A git-ignored lockfile is left alone (with a warning).
- `pnpm-lock.yaml` and `yarn.lock` do not record the root version, so they need
  nothing. `bun.lock` / `bun.lockb` are **not** handled — re-run `bun install`
  after releasing.

## API

The package also exports `bumpVersion` and `syncPackageLockVersion` utility
functions and a `VersionType` type. Importing the module has **no side
effects** — the CLI only runs when the file is executed directly.

```ts
import { bumpVersion, type VersionType } from "jsr:@marianmeres/deno-release";

bumpVersion("1.2.3", "patch"); // "1.2.4"
bumpVersion("1.2.3", "minor"); // "1.3.0"
bumpVersion("1.2.3", "major"); // "2.0.0"

// Invalid input throws a standard Error:
try {
  bumpVersion("not-semver", "patch");
} catch (e) {
  console.error((e as Error).message);
}
```

```ts
import { syncPackageLockVersion } from "jsr:@marianmeres/deno-release";

// returns the patched document text (or the input unchanged if the lockfile
// carries no root version); throws if the input is not valid JSON
const patched = syncPackageLockVersion(lockFileText, "1.2.4");
```

## Requirements

- Your project must have a `deno.json`, `jsr.json` or `package.json` with a
  `version` field
- Must be inside a git repository
- An `origin` remote must be configured
- All changes must be committed before releasing (can be bypassed with
  `--dry-run`)

## What it does

1. Validates you are in a git repo that contains a usable manifest
2. Checks for uncommitted changes (exits if any, unless `--dry-run`)
3. Warns if not on `main`/`master` branch
4. Pre-flight: verifies the target tag does not already exist, `origin` is
   configured, and any `package-lock.json` to be synced is parseable
5. Shows a preview of changes and asks for confirmation
6. Updates the `version` field in the manifest **preserving the original
   indentation**, and syncs `package-lock.json` on npm releases
7. Commits the change with message `Release: X.Y.Z [(custom message)]`
8. Creates annotated tag `vX.Y.Z` with the same message
9. Pushes the commit, then pushes the new tag explicitly to `origin`

If any of the mutation steps (steps 6-9) fail, the tool prints clear
instructions for rolling back the local state.

## Changes in 1.5.x (backward-compatibility notes)

- **`package.json` is now accepted as a manifest**, searched after
  `deno.json` and `jsr.json`. Repos with a Deno manifest resolve exactly as
  before; repos with only a `package.json` previously exited with "No manifest
  found".
- **Manifest resolution now skips candidates without a string `version`.**
  Previously the first *existing* candidate won, and a version-less
  `deno.json` was a hard error even when a versioned manifest sat next to it.
- **`package-lock.json` is rewritten** on `package.json` releases and included
  in the release commit.
- Versions are still strictly `X.Y.Z`. npm prerelease / build-metadata
  versions (`1.0.0-beta.1`, `1.0.0+build`) are rejected.

## Changes from 1.3.x (backward-compatibility notes)

Most users will notice no difference, but the following behaviors have
changed:

- **`bumpVersion` / `parseVersion` now throw on invalid input** instead of
  calling `Deno.exit(1)`. Library callers that previously relied on process
  termination must now `try`/`catch`. CLI behavior is unchanged (errors are
  caught at the top level and the process exits with code 1).
- **The module no longer runs the CLI on import.** Importing
  `jsr:@marianmeres/deno-release` previously triggered `main()` as a side
  effect; it now uses `import.meta.main` and only runs when executed
  directly. Any consumer that depended on the side-effecting import must
  now call the tool via `deno run` or `deno task`.
- **Tag push is now scoped to the new tag only** (`git push origin
  refs/tags/vX.Y.Z`) instead of `git push --tags`. If you relied on the
  release tool to batch-push unrelated orphan local tags, push them
  yourself with `git push --tags`.
- **Manifest indentation is preserved.** If your `deno.json` was
  previously being rewritten to 2-space indentation on every release,
  the next release will preserve whatever indentation the file currently
  has. If you want to switch, reformat the file once manually (e.g. with
  `deno fmt`) and the tool will respect the new style.
- **Pre-flight checks may reject releases that previously ran to a mid-way
  failure.** A release is now refused up-front if the target tag already
  exists locally or if no `origin` remote is configured.
- **Invalid first arguments that look like a version type typo
  (e.g. `minro`, `pacth`) now emit a warning** before falling through to
  the "treat as message, default to patch" behavior.
- `jsr.json` is now accepted as an alternative to `deno.json`. If both
  exist, `deno.json` wins.

## License

MIT
