# @marianmeres/release — Agent Guide

## Quick Reference

- **What**: CLI that bumps the version in `deno.json` / `jsr.json` / `package.json`
  (syncing `package-lock.json`), commits, tags and pushes. Zero runtime dependencies.
- **Stack**: TypeScript (erasable-only), Node LTS (`.node-version`), pnpm, `node:test`,
  Biome.
- **Install**: `pnpm install` | **Test**: `pnpm test` | **Check all**: `pnpm run ci` |
  **Build**: `pnpm run build`
- **Distribution**: one source, two registries. npm `@marianmeres/release` (`release`
  bin: `npx @marianmeres/release`) and JSR `@marianmeres/release`
  (`deno run -A jsr:@marianmeres/release`).

## Project Structure

```
src/release.ts              the whole CLI + exported helpers; JSR entry; `node src/release.ts` runs it
src/bin.ts                  npm `bin` entry; calls main() unconditionally
tests/release.test.ts       pure helpers (bumpVersion, syncPackageLockVersion)
tests/release.e2e.test.ts   spawns the CLI in temp git repos with a local bare origin
docs/cli.md                 normative CLI behaviour: flags, manifest resolution, hook, rollback, limits
docs/changes.md             notable behaviour changes per release
jsr.json                    JSR name / exports / include; no version (set at publish)
dist/                       `tsc -p tsconfig.build.json` output; gitignored; all npm gets
tmp/                        scratch, gitignored
```

## Critical Conventions

1. **Runtime policy**: Node at the keyboard and in production, npm as the registry. No
   `Deno.*`, `Bun.*`, `jsr:` or `npm:` specifiers; `node:*` only (no dependencies). Deno
   is a *consumer* runtime here (JSR consumers), not a dev runtime: `pnpm run test:deno`
   runs the e2e suite with the CLI on Deno.
2. **Erasable TypeScript**: no `enum`, `namespace`, constructor parameter properties;
   `import type` for types; explicit `.ts` import extensions. `pnpm run typecheck` is the
   only type gate (Node strips types, never checks them).
3. **Library paths never exit**: they throw `Error`. Only `main()` calls `process.exit`.
4. **Formatting**: tabs, 4 wide, 90 columns (`biome.json`). `pnpm run format` before
   committing; `pnpm run lint` is the read-only check CI runs.
5. **Tests**: `node:test` + `node:assert/strict`. The e2e suite needs `git` and a POSIX
   `sh`. `CLI_RUNTIME=deno` switches the spawned CLI to Deno.
6. **Versioning**: `package.json` is the manifest of record. `jsr.json` has no `version`;
   `publish:jsr` passes `--set-version "$npm_package_version"` and `--no-check`. Deno
   would type-check against the Node-targeted `tsconfig.json` and fail; `tsc` is the type
   gate and `test:deno` the Deno check.
7. **Releasing is a human action**: `pnpm run rp` / `rpm` = `node src/release.ts`
   (bump, commit, tag, push), then `pnpm publish` (`prepublishOnly`: `ci` + `build`),
   then `publish:jsr` (`test:deno` + `deno publish`). The tool releases itself from
   source.

## Before Making Changes

- [ ] Behaviour change: update [docs/cli.md](./docs/cli.md), add an e2e test, note it in
      [docs/changes.md](./docs/changes.md)
- [ ] New flag: also `usage()`, `KNOWN_FLAGS` (did-you-mean), the README options table
- [ ] `pnpm run ci`; also `pnpm run test:deno` when touching process / fs / child process
      code
- [ ] Consumers pin this tool in their lockfiles: a new flag reaches them only after they
      bump the pinned version

## Documentation Index

- [README.md](./README.md): human-facing docs
- [docs/cli.md](./docs/cli.md): CLI specification
- [docs/changes.md](./docs/changes.md): notable behaviour changes
