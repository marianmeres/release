# @marianmeres/release

An opinionated, interactive CLI tool for releasing Deno / JSR / npm projects.
Bumps the version in `deno.json` (or `jsr.json`, or `package.json`), creates an
annotated git tag, and pushes the commit together with the new tag to the remote
repository.

> Renamed from `@marianmeres/deno-release` once the tool learned to release npm
> projects too. Migrating is a one-line change; see [Legacy](#legacy).

## Features

- Bump by keyword (`major`, `minor`, `patch`) or to an exact version
- Prerelease versions (`1.2.3-rc.1`), promoted correctly by a later bump
- Interactive confirmation before making changes
- Non-interactive mode with `--yes` for CI/CD pipelines
- `--dry-run` to preview actions without touching anything
- `--verbose` for diagnostic command logging
- `--tag-prefix` for custom or absent git tag prefixes
- `--no-push` to stop after the commit and tag
- Unknown options are **rejected**, never silently treated as message text
- Supports `deno.json`, `jsr.json` and `package.json` manifests
- Keeps `package-lock.json` in sync on npm releases (so `npm ci` keeps working)
- Preserves the original indentation of the manifest file
- Validates clean git state (no uncommitted changes)
- Warns when not on `main`/`master` branch
- Pre-flight checks: tag does not already exist, `origin` remote is configured
- Pushes only the newly created tag (not all local tags)
- Zero runtime dependencies

## Usage

```
release [<major|minor|patch|X.Y.Z[-pre]>] [message...] [options]
```

| Option             | Alias | Effect                                         |
| ------------------ | ----- | ---------------------------------------------- |
| `--yes`            | `-y`  | Skip confirmation prompts (for CI).            |
| `--dry-run`        | `-n`  | Preview everything; change nothing.            |
| `--verbose`        |       | Log every git command before it runs.          |
| `--help`           | `-h`  | Show usage.                                    |
| `--tag-prefix <s>` |       | Git tag prefix (default `v`; `""` for none).   |
| `--no-push`        |       | Create the commit and tag, but do not push.    |
| `--`               |       | Treat all remaining arguments as message text. |

Options can appear anywhere in the argument list.

### Via `deno run`

```bash
# Patch release (1.0.0 -> 1.0.1); patch is the default
deno run -A jsr:@marianmeres/release patch

# Minor / major
deno run -A jsr:@marianmeres/release minor
deno run -A jsr:@marianmeres/release major

# Exact version, including prereleases
deno run -A jsr:@marianmeres/release 1.2.3
deno run -A jsr:@marianmeres/release 2.0.0-rc.1

# With custom message
deno run -A jsr:@marianmeres/release patch "Fixed critical bug"

# Skip confirmation prompts (useful for CI/CD)
deno run -A jsr:@marianmeres/release --yes patch

# Preview without making changes
deno run -A jsr:@marianmeres/release --dry-run minor

# Unprefixed tag, and stop before pushing
deno run -A jsr:@marianmeres/release patch --tag-prefix "" --no-push
```

### As a Deno task

```json
{
	"tasks": {
		"release": "deno run -A jsr:@marianmeres/release"
	}
}
```

```bash
deno task release patch
deno task release minor "Added new feature"
deno task release --dry-run minor
```

### Install globally

```bash
deno install -A -g -n release jsr:@marianmeres/release
```

### npm projects

A repo with only a `package.json` works the same way — there is nothing to
configure:

```json
{
	"scripts": {
		"release": "deno run -A jsr:@marianmeres/release"
	}
}
```

```bash
npm run release -- patch
npm run release -- minor "Added new feature"
```

The tool never publishes to npm; it only bumps, commits, tags and pushes, so
`"private": true` packages are fine.

If you publish before pushing, `--no-push` keeps a failed publish from leaving a
tag on the remote:

```json
{
	"scripts": {
		"rp": "npm run build && deno run -A jsr:@marianmeres/release patch --no-push -y && npm publish && git push --follow-tags"
	}
}
```

## Versions

The version argument is either a bump keyword (`major`, `minor`, `patch`) or an
exact version. Exact versions may carry a prerelease label; build metadata
(`+sha`) is rejected, since git tags and registries treat it inconsistently.

A prerelease counts as the release it precedes, matching `npm version`:

```
1.2.3-rc.1  + patch  ->  1.2.3
1.2.3-rc.1  + minor  ->  1.3.0
1.2.3-rc.1  + major  ->  2.0.0
```

Without that rule, releasing an explicit prerelease would leave the manifest in
a state no keyword bump could move forward.

## Manifest resolution

The manifest is the first of `deno.json`, `jsr.json`, `package.json` that
exists **and** carries a string `version` field. Candidates without a `version`
are skipped, so a `deno.json` kept purely for tasks / imports next to a
versioned `package.json` resolves to the `package.json`.

When more than one candidate is present, the chosen one is printed together
with a note listing the others (which are _not_ updated).

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

This is a CLI first, but the pure helpers are exported for reuse. Importing the
module has **no side effects** — the CLI only runs when the file is executed
directly.

```ts
import { bumpVersion, type VersionType } from "jsr:@marianmeres/release";

bumpVersion("1.2.3", "patch"); // "1.2.4"
bumpVersion("1.2.3", "minor"); // "1.3.0"
bumpVersion("1.2.3", "major"); // "2.0.0"
bumpVersion("1.2.3-rc.1", "patch"); // "1.2.3"

// Invalid input throws a standard Error:
try {
	bumpVersion("not-semver", "patch");
} catch (e) {
	console.error((e as Error).message);
}
```

```ts
import { syncPackageLockVersion } from "jsr:@marianmeres/release";

// returns the patched document text (or the input unchanged if the lockfile
// carries no root version); throws if the input is not valid JSON
const patched = syncPackageLockVersion(lockFileText, "1.2.4");
```

## Requirements

- Your project must have a `deno.json`, `jsr.json` or `package.json` with a
  `version` field
- Must be inside a git repository
- An `origin` remote must be configured (unless `--no-push`)
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

## Legacy

Everything before 2.0.0 is archived and receives no further releases: the JSR
package `@marianmeres/deno-release` (frozen at 1.5.0) and, before that, an npm
CLI that also happened to be called `@marianmeres/release`. Neither is related
to this package beyond lineage.

Migrating off `deno-release` is a one-line change:

```diff
-"release": "deno run -A jsr:@marianmeres/deno-release"
+"release": "deno run -A jsr:@marianmeres/release"
```

Old invocations that 2.0.0 will now reject rather than misinterpret:

- **Unknown options** are errors instead of becoming commit-message text, so a
  mistyped flag no longer releases silently. Use `--` to pass through message
  text starting with a dash.
- **`-v`** is not accepted — use `--verbose`.
- **An exact first argument is the version**, not the commit message.
- **`-d` (multi-directory) and `--suffix`** are gone. Release packages
  individually, and use an exact prerelease version instead of a suffix.

Note that changing the specifier rewrites `deno.lock`, which then trips the
clean-tree check — commit `deno.json` and `deno.lock` together first.

## License

MIT
