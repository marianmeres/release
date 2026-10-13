# @marianmeres/release

## Overview

- **Type**: CLI tool
- **Runtime**: Deno
- **Registry**: JSR (jsr:@marianmeres/release)
- **Entry point**: `release.ts`
- **Renamed from**: `@marianmeres/deno-release` (archived)
- **Purpose**: Automate semantic version releases for Deno / JSR / npm projects

## Package Structure

```
@marianmeres/release/
├── deno.json            # Package manifest with version, exports, formatting config
├── release.ts           # Main executable script (shebang: #!/usr/bin/env -S deno run -A)
├── release.test.ts      # Unit tests (pure functions)
├── release.e2e.test.ts  # End-to-end tests (real git repos in temp dirs)
├── README.md            # User documentation
├── AGENTS.md            # This file
└── mcp-include.txt      # MCP short description
```

## CLI Interface

### Invocation

```bash
deno run -A jsr:@marianmeres/release [options] [version] [message...]
```

### Arguments

| Position | Name    | Required | Values                                      | Description                                         |
| -------- | ------- | -------- | ------------------------------------------- | --------------------------------------------------- |
| 1        | version | No       | `major`, `minor`, `patch`, or `X.Y.Z[-pre]` | Bump keyword or exact version (defaults to `patch`) |
| 2+       | message | No       | Any string (space-separated)                | Appended to commit/tag message                      |

If the first positional argument is neither a valid version type nor a valid
exact version, it is treated as part of the commit message and the bump
defaults to `patch`. A warning is printed when the argument looks like a likely
typo of a version type (e.g. `minro`, `pacth`).

An exact version equal to the manifest's current version is rejected.

### Flags

| Flag                    | Alias | Effect                                                                                                                                                                                                |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--yes`                 | `-y`  | Skip all confirmation prompts (non-interactive).                                                                                                                                                      |
| `--dry-run`             | `-n`  | Preview all actions; make no mutations.                                                                                                                                                               |
| `--verbose`             |       | Log every git command before it runs. **No `-v` alias** — it is rejected outright.                                                                                                                    |
| `--help`                | `-h`  | Print usage and exit 0 without touching anything.                                                                                                                                                     |
| `--tag-prefix <s>`      |       | Git tag prefix; default `"v"`, `""` for none. Also accepts `--tag-prefix=<s>`.                                                                                                                        |
| `--no-push`             |       | Create the commit and tag but do not push. Also skips the `origin` pre-flight.                                                                                                                        |
| `--before-commit <cmd>` |       | Shell command run after the manifest write, before staging; the whole tree is then staged. Also `--before-commit=<cmd>`. Once only; empty is an error. See [Before-Commit Hook](#before-commit-hook). |
| `--`                    |       | Treat every remaining argument as message text.                                                                                                                                                       |

Flags can appear anywhere in the argument list.

### Unknown options are rejected

Any unrecognized `-`-prefixed token is a hard error (exit 1, nothing mutated)
with a Levenshtein-based did-you-mean hint. Flags retired from the legacy npm
CLI (`-v`, `-d`, `--dir`, `--suffix`, `--git-tag-prefix`,
`--git-tag-prefix-none`, `-m`) get a specific message naming their replacement.

This is the single most important behavioural change in 2.0.0: in 1.x these all
silently became commit-message text, so `--help` prepared a real release and
`-v 1.2.3` patch-bumped with `1.2.3` as the message.

### Exit Codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Success or user cancelled                                                           |
| 1    | Error (invalid args, dirty git, missing files, pre-flight failure, command failure) |

## Exported API

### Types

```typescript
export type VersionType = "major" | "minor" | "patch";

export type VersionSpec =
	| { kind: "bump"; type: VersionType }
	| { kind: "exact"; version: string };
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
- **Prerelease semantics**: a prerelease counts as the release it precedes
  (`1.2.3-rc.1` + `patch` -> `1.2.3`), matching `npm version` / `semver.inc`.
  Build metadata (`+sha`) is rejected.

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
  fail mid-release). An _untracked_ one cannot reach this point — the clean
  tree check rejects it earlier.
- The lockfile is `git add`ed alongside the manifest and named in the preview
  and in the rollback hints.
- `pnpm-lock.yaml` (v9) and `yarn.lock` carry no root version — no-ops by
  design, no warning. `bun.lock` / `bun.lockb` are **not** supported.

## Before-Commit Hook

`--before-commit <cmd>` exists for repos that commit a build artifact embedding
the package version: it can only be built correctly once the manifest carries
the new version, and it must land in the tagged commit (deploys of the form
`git checkout vX.Y.Z` on a non-building host).

- **When**: after the manifest (and synced lockfile) are written, after the
  confirmation prompt, before anything is staged. Never under `--dry-run`
  (the preview prints `- Run before commit: <cmd>` between the manifest
  line and the commit line instead).
- **How**: `sh -c <cmd>` (POSIX) / `cmd /c <cmd>` (Windows, untested), cwd =
  process cwd, stdio inherited (`runShellInherited`, a sibling of the piping
  `run()`). `--verbose` traces it as `$ sh -c '<cmd>'`.
- **Env** (merged into the inherited environment): `RELEASE_VERSION`,
  `RELEASE_PREV_VERSION`, `RELEASE_TAG` (with prefix), `RELEASE_MANIFEST`
  (relative path).
- **Staging rule**: with the hook, `git add -A` (whole tree, `.gitignore`
  respected, untracked artifacts included). Without it, exactly
  `git add <manifest> [<lockfile>]` — unchanged from 2.0.x. `-A` is safe only
  because the clean-tree check is whole-repo and explicitly includes untracked
  files (`--untracked-files=normal`), so at that point the tree holds nothing
  but the bump and the hook's output.
- **Failure** (non-zero exit or signal): nothing is staged, committed or
  tagged. The tool rewrites the manifest and lockfile from the text it read
  pre-flight (`manifestText`, `lockText`; the lockfile only if it was actually
  written), prints
  `Error: --before-commit command failed (exit N): <cmd>`,
  `Restored <manifest>[ and <lockfile>].`, and points to `git status` for
  anything the command left behind. Nothing else is cleaned up — `git clean`
  on the user's tree would be guesswork. Exit 1.
- **Single hook**: a repeated flag is a hard error with the hint to chain with
  `&&`. An empty / whitespace-only command is also rejected.
- **No freshness check**: the exit code is the only signal. A command that
  changes nothing yields a commit containing just the manifest.

## Execution Flow

1. **Parse arguments**: Extract flags, version spec, and optional message
   from `Deno.args`. Unknown `-` options throw (caught in `main`, exit 1).
   `--help` prints usage and returns before any git access. Unknown
   first-positional values warn on likely typos and fall through to
   "default patch + message" behaviour.
2. **Check git repository**: `git rev-parse --is-inside-work-tree`
3. **Locate manifest**: First of `deno.json` / `jsr.json` / `package.json`
   that exists and has a string `version` (read + parsed here)
4. **Check git status**: Fail on uncommitted changes, untracked files
   included regardless of `status.showUntrackedFiles`
   (`git status --porcelain --untracked-files=normal`; warn-only in
   `--dry-run`)
5. **Check branch**: Warn if not on `main` or `master`, prompt to continue
6. **Calculate new version**: `bumpVersion` for a keyword spec, or the exact
   version verbatim (rejected if identical to the current one)
7. **Pre-flight checks (read-only; fail fast)**:
   - Target tag `vX.Y.Z` must not already exist locally
   - `origin` remote must be configured (skipped under `--no-push`)
   - `package-lock.json` (npm manifests only) must be parseable and not
     git-ignored
8. **Confirm with user**: Show preview, require "y" to proceed (skipped on
   `--yes`; `--dry-run` exits here without mutating).
9. **Update manifest**: Rewrite the file with the new version, preserving
   the original indentation (detected from the source) and trailing newline.
   On npm manifests, `package-lock.json` is patched the same way.
10. **Before-commit hook** (only with `--before-commit`): run the command;
    on failure restore the files from step 9 and exit 1. See
    [Before-Commit Hook](#before-commit-hook).
11. **Git operations** (wrapped in try/catch; on failure a rollback hint
    is printed):
    - `git add <manifest>` (plus `package-lock.json` when synced), or
      `git add -A` when `--before-commit` was given
    - `git commit -m "Release: X.Y.Z [(custom message)]"`
    - `git tag -a vX.Y.Z -m "Release: X.Y.Z [(custom message)]"`
12. **Push to remote** (skipped under `--no-push`, which prints the manual
    push command instead):
    - `git push`
    - `git push origin refs/tags/vX.Y.Z` (only the new tag, not all tags)

## Dependencies

- **External**: None (zero dependencies)
- **Deno APIs used**:
  - `Deno.args` - CLI arguments
  - `Deno.Command` - Shell command execution (git piped; the before-commit
    hook with inherited stdio)
  - `Deno.build.os` - Picks `sh -c` vs `cmd /c` for the hook
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
- `origin` remote must be configured (unless `--no-push`)
- Working tree must be clean, untracked files included (unless using
  `--dry-run`)

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
- Tag name format: `vX.Y.Z` by default; the `v` comes from `--tag-prefix`

## Manifest Rewrite Semantics

- The `version` field is replaced; all other keys keep their original order
  and values.
- Indentation is preserved: detected from the first indented line of the
  original file (tabs or spaces), defaulting to 2 spaces.
- A trailing newline is preserved if the original file had one.
- The same `serializeLike` helper is used for the manifest and the lockfile.

## Rollback Behaviour

If any git step fails (add, commit, tag, push), the tool exits with code 1
and prints guidance:

```
git tag -d vX.Y.Z         # remove local tag if created
git reset --hard HEAD~1   # undo local commit if created
git checkout HEAD -- <manifest> [package-lock.json]   # discard an uncommitted bump
```

With `--before-commit` the last line is `git checkout HEAD -- .`, since the
tree then also holds the hook's output (new untracked files survive a checkout;
the hint says to look at `git status`). `HEAD` is explicit so the hint also
undoes a `git add` that succeeded before the commit failed — a plain
`git checkout -- <path>` restores from the index, which already holds the bump.

The rollback is not performed automatically — the user decides based on how
far the release progressed. The one exception is a failing before-commit hook,
where the tool restores the manifest and lockfile it wrote itself (see
[Before-Commit Hook](#before-commit-hook)).

## Configuration

- **Formatting** (in this repo's `deno.json`):
  - Uses tabs for indentation
  - Line width: 90 characters
  - Indent width: 4
  - Prose wrap: preserve

## Limitations

- Prerelease versions are supported only as an **exact** argument; there is no
  way to _iterate_ a prerelease (no `1.2.3-rc.1` -> `1.2.3-rc.2`). Build
  metadata (`+sha`) is rejected outright
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
- No automatic rollback on mid-release git failure (prints guidance only);
  only a failing `--before-commit` hook restores the manifest / lockfile
- One `--before-commit` hook, run only before the commit; no `--after-tag` /
  `--after-push`. Publishing belongs in the caller's task after the tool exits
- Windows shebang support depends on the host (POSIX `env -S`); the
  `cmd /c` path of `--before-commit` is untested

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

- `release.test.ts` — pure functions (`bumpVersion`,
  `syncPackageLockVersion`): lockfileVersion 1 vs 3, absent version field,
  tab indentation, trailing newline, key order.
- `release.e2e.test.ts` — spawns the CLI inside temp git repos with a
  local bare `origin`: manifest resolution order, version-less candidate
  skipping, npm bump + lockfile sync round-trip, pre-flight failure leaving
  the tree untouched, `deno.json` release not touching the lockfile,
  git-ignored lockfile handling, CLI surface (unknown / retired flags,
  `--help`, `--`, exact versions, `--tag-prefix`, `--no-push`), and
  `--before-commit`: artifact lands in the tagged commit (both flag forms),
  `RELEASE_*` env vars, ignored output not staged, lockfile synced before the
  hook, failure restores manifest + lockfile and leaves the hook's files,
  `--dry-run` never runs it, missing / empty / repeated value errors,
  did-you-mean, targeted `git add` still the default without the flag
  (asserted via `--verbose`), widened rollback hint, and the clean check
  seeing untracked files under `status.showUntrackedFiles=no`. All hook
  tests assume a POSIX `sh`.

## Notable Behaviour Changes in 2.0.0

- Package renamed from `@marianmeres/deno-release` (archived); entry point
  renamed `deno-release.ts` -> `release.ts`.
- **Unknown `-` options are rejected** instead of becoming commit-message text.
- `-v` is no longer an alias for `--verbose` and is not accepted at all.
- An exact version (`X.Y.Z` or `X.Y.Z-prerelease`) is accepted as the first
  positional argument.
- `bumpVersion` accepts prerelease input and promotes it (`1.2.3-rc.1` +
  `patch` -> `1.2.3`) instead of throwing.
- New flags: `--help` / `-h`, `--tag-prefix <s>`, `--no-push`, and `--`.
- New export: `VersionSpec`.
- Dropped (never present here, only in the archived npm CLI): multi-directory
  mode `-d`, and `--suffix`.

## Notable Behaviour Changes in 2.1.0

- New flag `--before-commit <cmd>` (also `--before-commit=<cmd>`): runs a
  shell command between the manifest write and the commit, then stages the
  whole tree (`git add -A`). Without it staging is unchanged.
- The clean-tree check passes `--untracked-files=normal` explicitly, so
  untracked files block a release even under `status.showUntrackedFiles=no`
  (previously they were invisible to the check under that setting).
- Rollback hint uses `git checkout HEAD -- …` instead of `git checkout -- …`,
  so it also undoes a staged-but-uncommitted bump.
