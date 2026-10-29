# Notable Behaviour Changes

Per release, oldest first. Entry point: [AGENTS.md](../AGENTS.md).

## 1.4.x (from 1.3.x)

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

## 1.5.x

- `package.json` is accepted as a manifest (searched last).
- Manifest resolution skips candidates without a string `version` instead of
  hard-failing on the first existing candidate.
- `package-lock.json` is synced and committed on npm releases.
- A note is printed when multiple manifest candidates are present.


## 2.0.0

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

## 2.1.0

- New flag `--before-commit <cmd>` (also `--before-commit=<cmd>`): runs a
  shell command between the manifest write and the commit, then stages the
  whole tree (`git add -A`). Without it staging is unchanged.
- The clean-tree check passes `--untracked-files=normal` explicitly, so
  untracked files block a release even under `status.showUntrackedFiles=no`
  (previously they were invisible to the check under that setting).
- Rollback hint uses `git checkout HEAD -- …` instead of `git checkout -- …`,
  so it also undoes a staged-but-uncommitted bump.

## 2.2.0

- **Runs on Node.** `src/release.ts` uses `node:*` only (no `Deno.*`, no
  `prompt`). Published to npm as `@marianmeres/release` with a `release` bin
  (`npx @marianmeres/release`), superseding the deprecated 1.x npm CLI of the
  same name. JSR stays: `deno run -A jsr:@marianmeres/release` runs the same
  source on Deno.
- New export `main()` — the CLI entry, exported for `src/bin.ts`.
- Confirmation prompts read piped input: `echo y | release` now proceeds
  (Deno's `prompt` returned `null` for a non-terminal stdin, which cancelled).
  Stdin closing without an answer still counts as "no".
- Deno without `-A`: `--before-commit` reads `process.env`, so it needs
  `--allow-env` in addition to `--allow-run --allow-read --allow-write`.
- Repo: Node toolchain (pnpm, `node:test`, `tsc`, Biome), `src/` + `tests/`
  layout, `package.json` is the manifest of record; `jsr.json` carries no
  version (`deno publish --set-version`).
