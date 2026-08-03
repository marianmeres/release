# @marianmeres/deno-release

## Overview

- **Type**: CLI tool
- **Runtime**: Deno
- **Registry**: JSR (jsr:@marianmeres/deno-release)
- **Entry point**: `deno-release.ts`
- **Purpose**: Automate semantic version releases for Deno / JSR / npm projects

## Package Structure

```
@marianmeres/deno-release/
├── deno.json               # Package manifest with version, exports, formatting config
├── deno-release.ts         # Main executable script (shebang: #!/usr/bin/env -S deno run -A)
├── deno-release.test.ts    # Unit tests (pure functions)
├── deno-release.e2e.test.ts# End-to-end tests (real git repos in temp dirs)
├── README.md               # User documentation
├── AGENTS.md               # This file
└── mcp-include.txt         # MCP short description
```

## CLI Interface

### Invocation

```bash
deno run -A jsr:@marianmeres/deno-release [flags] [version-type] [custom-message...]
```

### Arguments

| Position | Name           | Required | Values                       | Description                          |
|----------|----------------|----------|------------------------------|--------------------------------------|
| 1        | version-type   | No       | `major`, `minor`, `patch`    | Semantic version component to bump (defaults to `patch`) |
| 2+       | custom-message | No       | Any string (space-separated) | Appended to commit/tag message       |

If the first positional argument is not a valid version type, it is treated as
part of the commit message and the bump defaults to `patch`. A warning is
printed when the argument looks like a likely typo of a version type
(e.g. `minro`, `pacth`).

### Flags

| Flag              | Alias | Effect                                             |
|-------------------|-------|----------------------------------------------------|
| `--yes`           | `-y`  | Skip all confirmation prompts (non-interactive).   |
| `--dry-run`       | `-n`  | Preview all actions; make no mutations.            |
| `--verbose`       | `-v`  | Log every git command before it runs.              |

Flags can appear anywhere in the argument list.

### Exit Codes

| Code | Meaning                                      |
|------|----------------------------------------------|
| 0    | Success or user cancelled                    |
| 1    | Error (invalid args, dirty git, missing files, pre-flight failure, command failure) |

## Exported API

### Types

```typescript
export type VersionType = "major" | "minor" | "patch";
```

### Functions

```typescript
export function bumpVersion(current: string, type: VersionType): string;
```

- **Input**: Semver string (e.g., "1.2.3") and bump type
- **Output**: New version string
- **Behavior**: Increments specified component, resets lower components to 0
- **Errors**: Throws `Error` on invalid version format or invalid bump type.
  Never calls `Deno.exit` from library paths.

```typescript
export function syncPackageLockVersion(lockText: string, newVersion: string): string;
```

- **Input**: `package-lock.json` document text and the target version
- **Output**: Patched document text, or the input **unchanged** (identity-
  comparable) when the lockfile carries no root version field
- **Behavior**: Sets `version` and, when present, `packages[""].version`.
  Fields that do not already exist are never created. Indentation and trailing
  newline are mirrored from the input. Nested dependency versions and key
  order are untouched.
- **Errors**: Throws `Error` (from `JSON.parse`) on invalid JSON.

### Module side effects

Importing the module does **not** execute the CLI. The `main()` function is
guarded with `if (import.meta.main)` so library consumers can import
`bumpVersion` without triggering CLI behaviour.

## Manifest Resolution

On startup the tool searches the current working directory for a manifest in
this order:

1. `deno.json`
2. `jsr.json`
3. `package.json`

The first candidate that exists **and** has a string `version` field is used.
Candidates that exist but lack a `version` are skipped — this matters for repos
that keep a `deno.json` only for tasks / imports alongside a versioned
`package.json`. A candidate that exists but is not valid JSON is a hard error
(it is not silently skipped).

When more than one candidate exists, the chosen manifest is printed along with
a note naming the others; only the chosen one is updated.

## Lockfile Sync (npm only)

When the resolved manifest is `package.json` and `package-lock.json` exists
next to it, the lockfile's root version is patched in the same commit —
otherwise `npm ci` breaks, since it refuses to run on a lockfile that
disagrees with `package.json`.

- Patched directly via `syncPackageLockVersion`; npm is never shelled out to,
  so no network / `node_modules` / `npm` on `PATH` is required.
- Pre-flight parses the lockfile; unparseable ⇒ exit 1 before any mutation.
- A git-ignored lockfile is skipped with a warning (`git add` would otherwise
  fail mid-release). An *untracked* one cannot reach this point — the clean
  tree check rejects it earlier.
- The lockfile is `git add`ed alongside the manifest and named in the preview
  and in the rollback hints.
- `pnpm-lock.yaml` (v9) and `yarn.lock` carry no root version — no-ops by
  design, no warning. `bun.lock` / `bun.lockb` are **not** supported.

## Execution Flow

1. **Parse arguments**: Extract flags, version type, and optional message
   from `Deno.args`. Unknown first-positional values warn on likely typos and
   fall through to "default patch + message" behaviour.
2. **Check git repository**: `git rev-parse --is-inside-work-tree`
3. **Locate manifest**: First of `deno.json` / `jsr.json` / `package.json`
   that exists and has a string `version` (read + parsed here)
4. **Check git status**: Fail on uncommitted changes (warn-only in `--dry-run`)
5. **Check branch**: Warn if not on `main` or `master`, prompt to continue
7. **Calculate new version**: Apply bump logic via `bumpVersion`
8. **Pre-flight checks (read-only; fail fast)**:
    - Target tag `vX.Y.Z` must not already exist locally
    - `origin` remote must be configured
    - `package-lock.json` (npm manifests only) must be parseable and not
      git-ignored
9. **Confirm with user**: Show preview, require "y" to proceed (skipped on
   `--yes`; `--dry-run` exits here without mutating).
10. **Update manifest**: Rewrite the file with the new version, preserving
    the original indentation (detected from the source) and trailing newline.
    On npm manifests, `package-lock.json` is patched the same way.
11. **Git operations** (wrapped in try/catch; on failure a rollback hint
    is printed):
    - `git add <manifest>` (plus `package-lock.json` when synced)
    - `git commit -m "Release: X.Y.Z [(custom message)]"`
    - `git tag -a vX.Y.Z -m "Release: X.Y.Z [(custom message)]"`
12. **Push to remote**:
    - `git push`
    - `git push origin refs/tags/vX.Y.Z`  (only the new tag, not all tags)

## Dependencies

- **External**: None (zero dependencies)
- **Deno APIs used**:
  - `Deno.args` - CLI arguments
  - `Deno.Command` - Shell command execution
  - `Deno.stat` - File existence check
  - `Deno.readTextFile` - Read manifest
  - `Deno.writeTextFile` - Write manifest
  - `Deno.exit` - Process termination (CLI top level only)
  - `prompt` - User input (built-in)
- **Dev-only**: tests use no assertion library (local helpers), and are
  excluded from `deno publish` via `publish.exclude`

## Requirements for Target Projects

- Must have `deno.json`, `jsr.json` or `package.json` in working directory
- The manifest must contain a `version` field with valid semver (`X.Y.Z`)
- Must be inside a git repository
- `origin` remote must be configured
- Working tree must be clean (unless using `--dry-run`)

## Output Format

- Uses ANSI escape codes for colored terminal output:
    - Red (`\x1b[31m`): Errors
    - Green (`\x1b[32m`): Success messages, new version
    - Yellow (`\x1b[33m`): Warnings, dry-run notices, rollback hints
    - Bold (`\x1b[1m`): Emphasis
    - Dim (`\x1b[2m`): Verbose command traces

## Commit/Tag Message Format

- Without custom message: `Release: X.Y.Z`
- With custom message: `Release: X.Y.Z (custom message here)`
- Tag name format: `vX.Y.Z` (prefixed with "v")

## Manifest Rewrite Semantics

- The `version` field is replaced; all other keys keep their original order
  and values.
- Indentation is preserved: detected from the first indented line of the
  original file (tabs or spaces), defaulting to 2 spaces.
- A trailing newline is preserved if the original file had one.
- The same `serializeLike` helper is used for the manifest and the lockfile.

## Rollback Behaviour

If any mutation step fails (commit, tag, push), the tool exits with code 1
and prints guidance:

```
git tag -d vX.Y.Z         # remove local tag if created
git reset --hard HEAD~1   # undo local commit if created
git checkout -- <manifest> [package-lock.json]   # discard an uncommitted bump
```

The rollback is not performed automatically — the user decides based on how
far the release progressed.

## Configuration

- **Formatting** (in this repo's `deno.json`):
  - Uses tabs for indentation
  - Line width: 90 characters
  - Indent width: 4
  - Prose wrap: preserve

## Limitations

- Only supports standard semver (`X.Y.Z`), no pre-release or build metadata.
  This bites npm projects hardest (`1.0.0-beta.1` is legal npm, rejected here)
- Only checks for `main` or `master` branch names
- No support for monorepos or Deno / npm workspaces (picks a single manifest
  at cwd; workspace member versions are not touched)
- Only `package-lock.json` is synced — not `npm-shrinkwrap.json`, not
  `bun.lock` (which does carry a root version, but is JSONC)
- A manifest is never cross-checked against the others: a `package.json`
  sitting next to a bumped `deno.json` goes stale (a note is printed)
- No changelog generation
- `jsr.jsonc` / `deno.jsonc` (with comments) are **not** supported —
  `JSON.parse` is used, not a JSONC parser
- No automatic rollback on mid-release failure (prints guidance only)
- Windows shebang support depends on the host (POSIX `env -S`)

## Notable Behaviour Changes from 1.3.x

- `bumpVersion` / `parseVersion` throw on invalid input instead of
  `Deno.exit(1)`.
- `main()` is guarded by `import.meta.main`, so importing the module no
  longer runs the CLI.
- Only the newly created tag is pushed (`git push origin refs/tags/vX.Y.Z`),
  not all local tags.
- Manifest indentation is preserved on write.
- Pre-flight checks reject the release before any mutation if the tag
  already exists or if `origin` is missing.
- Typo-like first arguments trigger a warning.
- `jsr.json` is accepted as a manifest.
- New flags: `--dry-run` / `-n`, `--verbose` / `-v`.

## Notable Behaviour Changes in 1.5.x

- `package.json` is accepted as a manifest (searched last).
- Manifest resolution skips candidates without a string `version` instead of
  hard-failing on the first existing candidate.
- `package-lock.json` is synced and committed on npm releases.
- A note is printed when multiple manifest candidates are present.

## Testing

```bash
deno task test    # deno test -A
```

- `deno-release.test.ts` — pure functions (`bumpVersion`,
  `syncPackageLockVersion`): lockfileVersion 1 vs 3, absent version field,
  tab indentation, trailing newline, key order.
- `deno-release.e2e.test.ts` — spawns the CLI inside temp git repos with a
  local bare `origin`: manifest resolution order, version-less candidate
  skipping, npm bump + lockfile sync round-trip, pre-flight failure leaving
  the tree untouched, `deno.json` release not touching the lockfile,
  git-ignored lockfile handling.
