# @marianmeres/deno-release

An opinionated, interactive CLI tool for releasing Deno / JSR projects. Bumps
the version in `deno.json` (or `jsr.json`), creates an annotated git tag, and
pushes the commit together with the new tag to the remote repository.

## Features

- Semantic versioning (`major`, `minor`, `patch`)
- Interactive confirmation before making changes
- Non-interactive mode with `--yes` flag for CI/CD pipelines
- `--dry-run` mode to preview actions without touching anything
- `--verbose` mode for diagnostic command logging
- Supports both `deno.json` and `jsr.json` manifests
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

## API

The package also exports a `bumpVersion` utility function and a `VersionType`
type. Importing the module has **no side effects** — the CLI only runs when
the file is executed directly.

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

## Requirements

- Your project must have a `deno.json` or `jsr.json` with a `version` field
- Must be inside a git repository
- An `origin` remote must be configured
- All changes must be committed before releasing (can be bypassed with
  `--dry-run`)

## What it does

1. Validates you are in a git repo that contains a `deno.json` or `jsr.json`
2. Checks for uncommitted changes (exits if any, unless `--dry-run`)
3. Warns if not on `main`/`master` branch
4. Pre-flight: verifies the target tag does not already exist and `origin`
   is configured
5. Shows a preview of changes and asks for confirmation
6. Updates the `version` field in the manifest **preserving the original
   indentation**
7. Commits the change with message `Release: X.Y.Z [(custom message)]`
8. Creates annotated tag `vX.Y.Z` with the same message
9. Pushes the commit, then pushes the new tag explicitly to `origin`

If any of the mutation steps (steps 6-9) fail, the tool prints clear
instructions for rolling back the local state.

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
