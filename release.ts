#!/usr/bin/env -S deno run -A

/**
 * @module
 * Opinionated CLI tool for releasing Deno / JSR / npm projects.
 *
 * Bumps the version in `deno.json` (or `jsr.json`, or `package.json`), creates
 * an annotated git tag, and pushes the commit together with the new tag to the
 * remote repository. When the manifest is a `package.json`, the root version in
 * `package-lock.json` is kept in sync so `npm ci` does not break.
 *
 * The manifest is the first of `deno.json`, `jsr.json`, `package.json` that
 * exists and carries a string `version` field.
 *
 * With `--before-commit <cmd>`, a shell command (typically a build) runs after
 * the manifest is bumped and before the release commit, and everything it
 * changes is committed alongside the manifest. This is for repos that commit
 * build artifacts embedding the package version.
 *
 * This is a CLI first; the pure {@link bumpVersion} and
 * {@link syncPackageLockVersion} helpers are exported for reuse. Importing the
 * module does not execute the CLI.
 *
 * @example
 * ```bash
 * deno run -A jsr:@marianmeres/release                    # defaults to patch
 * deno run -A jsr:@marianmeres/release patch
 * deno run -A jsr:@marianmeres/release minor "Added new feature"
 * deno run -A jsr:@marianmeres/release 1.2.3-rc.1         # exact version
 * deno run -A jsr:@marianmeres/release --yes patch        # skip confirmations
 * deno run -A jsr:@marianmeres/release --dry-run minor
 * deno run -A jsr:@marianmeres/release --before-commit "npm run build"
 * deno run -A jsr:@marianmeres/release --help
 * ```
 *
 * Renamed from `@marianmeres/deno-release` (archived).
 */

/** Semantic version bump type. */
export type VersionType = "major" | "minor" | "patch";

const VALID_VERSION_TYPES: VersionType[] = ["major", "minor", "patch"];

/** Manifest file names searched, in order of preference. */
const MANIFEST_CANDIDATES = ["deno.json", "jsr.json", "package.json"] as const;

/** npm manifest name (the only manifest with a lockfile we keep in sync). */
const NPM_MANIFEST = "package.json";

/** npm lockfile, synced only when {@link NPM_MANIFEST} is the resolved manifest. */
const NPM_LOCKFILE = "package-lock.json";

// Colors for terminal output
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

/** Result of running a shell command. */
interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

let VERBOSE = false;

/**
 * Executes a shell command and returns the result.
 * @param cmd - Array of command and arguments
 */
async function run(cmd: string[]): Promise<CommandResult> {
	if (VERBOSE) console.log(dim(`$ ${cmd.join(" ")}`));
	const command = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		stdout: "piped",
		stderr: "piped",
	});
	const { code, stdout, stderr } = await command.output();
	return {
		code,
		stdout: new TextDecoder().decode(stdout).trim(),
		stderr: new TextDecoder().decode(stderr).trim(),
	};
}

/** Run a command; on non-zero exit, log and terminate the process. */
async function runOrExit(cmd: string[]): Promise<string> {
	const { code, stdout, stderr } = await run(cmd);
	if (code !== 0) {
		console.error(red(`Error running: ${cmd.join(" ")}`));
		if (stderr) console.error(stderr);
		Deno.exit(1);
	}
	return stdout;
}

/** Run a command; on non-zero exit, throw (so the caller can clean up / hint). */
async function runOrThrow(cmd: string[]): Promise<string> {
	const { code, stdout, stderr } = await run(cmd);
	if (code !== 0) {
		throw new Error(
			`Command failed: ${cmd.join(" ")}${stderr ? `\n${stderr}` : ""}`,
		);
	}
	return stdout;
}

/** Shell invocation for a user-supplied command string. */
function shellCommand(cmd: string): string[] {
	return Deno.build.os === "windows" ? ["cmd", "/c", cmd] : ["sh", "-c", cmd];
}

/**
 * Runs a user-supplied command string through the platform shell with stdio
 * inherited, so its output (build logs, errors) reaches the terminal as-is.
 *
 * Unlike {@link run}, nothing is captured; the caller only learns how the
 * command ended. `env` is merged into the inherited environment.
 */
async function runShellInherited(
	cmd: string,
	env: Record<string, string>,
): Promise<{ code: number; signal: Deno.Signal | null }> {
	const argv = shellCommand(cmd);
	if (VERBOSE) console.log(dim(`$ ${argv[0]} ${argv[1]} '${cmd}'`));
	const { code, signal } = await new Deno.Command(argv[0], {
		args: argv.slice(1),
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}).output();
	return { code, signal };
}

/** Check whether a plain file exists at `path`. */
async function fileExists(path: string): Promise<boolean> {
	try {
		const stat = await Deno.stat(path);
		return stat.isFile;
	} catch {
		return false;
	}
}

/**
 * `X.Y.Z` with an optional prerelease label (`1.2.3-rc.1`).
 *
 * Build metadata (`+sha`) is deliberately rejected: git tags and registries
 * treat it inconsistently, and it has no ordering semantics worth honouring
 * in a release tool.
 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

interface ParsedSemver {
	major: number;
	minor: number;
	patch: number;
	/** Prerelease label without the leading `-`, or `null` for a plain release. */
	prerelease: string | null;
}

/**
 * Parses a semver string `X.Y.Z` or `X.Y.Z-prerelease`.
 * @throws on malformed input.
 */
function parseVersion(version: string): ParsedSemver {
	const m = SEMVER_RE.exec(version);
	if (!m) {
		throw new Error(
			`Invalid version format: ${
				JSON.stringify(version)
			} (expected "X.Y.Z" or "X.Y.Z-prerelease" with non-negative integers)`,
		);
	}
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		prerelease: m[4] ?? null,
	};
}

/**
 * Bumps a semantic version based on the specified type.
 *
 * A prerelease counts as the release it precedes, matching `npm version` /
 * `semver.inc`: bumping `1.2.3-rc.1` by `patch` yields `1.2.3`, not `1.2.4`.
 * Without this, a release made with an explicit prerelease version would leave
 * the manifest in a state no keyword bump could move forward.
 *
 * @throws if `current` is not a valid semver string or `type` is not one of
 *         `"major" | "minor" | "patch"`.
 *
 * @example
 * ```ts
 * bumpVersion("1.2.3", "patch");      // "1.2.4"
 * bumpVersion("1.2.3", "minor");      // "1.3.0"
 * bumpVersion("1.2.3", "major");      // "2.0.0"
 * bumpVersion("1.2.3-rc.1", "patch"); // "1.2.3"  (promotes the prerelease)
 * ```
 */
export function bumpVersion(current: string, type: VersionType): string {
	const parsed = parseVersion(current);
	let { major, minor, patch } = parsed;
	const { prerelease } = parsed;

	if (prerelease) {
		switch (type) {
			case "patch":
				return `${major}.${minor}.${patch}`;
			case "minor":
				return patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
			case "major":
				return minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
			default:
				throw new Error(`Invalid bump type: ${JSON.stringify(type)}`);
		}
	}

	switch (type) {
		case "major":
			major++;
			minor = 0;
			patch = 0;
			break;
		case "minor":
			minor++;
			patch = 0;
			break;
		case "patch":
			patch++;
			break;
		default:
			throw new Error(`Invalid bump type: ${JSON.stringify(type)}`);
	}
	return `${major}.${minor}.${patch}`;
}

/** Detect the indentation string used by a JSON document. */
function detectIndent(text: string): string {
	const m = text.match(/\n([ \t]+)"/);
	return m ? m[1] : "  ";
}

/**
 * Serialize `value` back to JSON, mirroring the source document's indentation
 * (tabs or spaces) and trailing-newline convention.
 */
function serializeLike(originalText: string, value: unknown): string {
	const indent = detectIndent(originalText);
	const trailingNewline = originalText.endsWith("\n") ? "\n" : "";
	return JSON.stringify(value, null, indent) + trailingNewline;
}

/**
 * Rewrites the *root* package version inside an npm `package-lock.json`
 * document, leaving every other field (and the file's formatting) untouched.
 *
 * npm stores the root version in up to two places, depending on
 * `lockfileVersion`:
 *
 * - `version` — present in all lockfile versions
 * - `packages[""].version` — lockfileVersion 2 and 3 only
 *
 * Only fields that already exist are updated; none are invented. If neither
 * field is present the input is returned unchanged, which the caller can detect
 * by identity comparison.
 *
 * @throws if `lockText` is not valid JSON.
 *
 * @example
 * ```ts
 * const patched = syncPackageLockVersion(await Deno.readTextFile("package-lock.json"), "1.2.4");
 * ```
 */
export function syncPackageLockVersion(
	lockText: string,
	newVersion: string,
): string {
	const lock = JSON.parse(lockText) as Record<string, unknown>;
	let found = false;

	if (typeof lock.version === "string") {
		lock.version = newVersion;
		found = true;
	}

	// lockfileVersion 2/3 repeat the root version under packages[""]
	const packages = lock.packages;
	if (packages && typeof packages === "object" && !Array.isArray(packages)) {
		const root = (packages as Record<string, unknown>)[""];
		if (root && typeof root === "object" && !Array.isArray(root)) {
			const rootPkg = root as Record<string, unknown>;
			if (typeof rootPkg.version === "string") {
				rootPkg.version = newVersion;
				found = true;
			}
		}
	}

	return found ? serializeLike(lockText, lock) : lockText;
}

/**
 * What version to release: either a keyword bump relative to the manifest's
 * current version, or an exact version supplied by the caller.
 */
export type VersionSpec =
	| { kind: "bump"; type: VersionType }
	| { kind: "exact"; version: string };

interface ParsedArgs {
	spec: VersionSpec;
	customMessage: string;
	skipPrompts: boolean;
	dryRun: boolean;
	verbose: boolean;
	help: boolean;
	/** Prefix for the git tag; `""` means an unprefixed tag. */
	tagPrefix: string;
	/** Whether to push the commit and tag to `origin`. */
	push: boolean;
	/**
	 * Shell command to run after the manifest is written and before anything
	 * is staged; `null` when not requested. When set, the whole tree is staged.
	 */
	beforeCommit: string | null;
}

const KNOWN_FLAGS = [
	"--yes",
	"--dry-run",
	"--verbose",
	"--help",
	"--tag-prefix",
	"--no-push",
	"--before-commit",
] as const;

/**
 * Flags that meant something in `@marianmeres/release` 1.x (the Node CLI this
 * tool replaces) and would otherwise be silently swallowed into the commit
 * message. `-v` is the dangerous one: it meant *version* there and *verbose*
 * here, so `release -v 1.2.3` used to set 1.2.3 and would now patch-bump with
 * "1.2.3" as the message.
 */
const RETIRED_FLAGS: Record<string, string> = {
	"-v": 'pass the version as a positional argument instead (e.g. "1.2.3"), ' +
		"or use --verbose for a command trace",
	"-d": "multi-directory mode was dropped; release each package separately",
	"--dir": "multi-directory mode was dropped; release each package separately",
	"--suffix": 'pass an exact prerelease version instead (e.g. "1.2.3-beta.1")',
	"--git-tag-prefix": "renamed to --tag-prefix",
	"--git-tag-prefix-none": 'replaced by --tag-prefix ""',
	"-m": "the commit message is a positional argument; use -- to be explicit",
};

/** Levenshtein distance, used only for did-you-mean hints. */
function editDistance(a: string, b: string): number {
	const rows = Array.from(
		{ length: a.length + 1 },
		(_, i) => [i, ...Array(b.length).fill(0)],
	);
	for (let j = 0; j <= b.length; j++) rows[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			rows[i][j] = Math.min(
				rows[i - 1][j] + 1,
				rows[i][j - 1] + 1,
				rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
	}
	return rows[a.length][b.length];
}

/** Build the "unknown flag" error message, with a hint where we can offer one. */
function unknownFlagError(flag: string): Error {
	const retired = RETIRED_FLAGS[flag];
	if (retired) {
		return new Error(`Unknown option '${flag}' — ${retired}.`);
	}
	const near = KNOWN_FLAGS
		.map((f) => [f, editDistance(flag, f)] as const)
		.filter(([, d]) => d <= 3)
		.sort((a, b) => a[1] - b[1])[0];
	const hint = near
		? `did you mean '${near[0]}'?`
		: `valid options: ${KNOWN_FLAGS.join(", ")}, -y, -n, -h`;
	return new Error(
		`Unknown option '${flag}' — ${hint}\n` +
			`       (use -- to pass it through as commit message text)`,
	);
}

function looksLikeVersionType(arg: string): boolean {
	if (arg.length > 10 || /\s/.test(arg)) return false;
	return /^(maj|mij|mjo|min|mni|pat|pth|pac|patc|majo|mino)/i.test(arg);
}

/** Usage text for `--help`. */
function usage(): string {
	return `Release a Deno / JSR / npm project: bump, commit, tag, push.

Usage:
  release [<major|minor|patch|X.Y.Z[-pre]>] [message...] [options]

Arguments:
  version   Bump keyword, or an exact version. Defaults to 'patch'.
  message   Free text appended to the commit and tag message.

Options:
  -y, --yes           Skip confirmation prompts (for CI).
  -n, --dry-run       Preview everything; change nothing.
      --verbose       Log every git command before it runs.
  -h, --help          Show this help.
      --tag-prefix <s>  Git tag prefix (default "v"; "" for no prefix).
      --no-push       Create the commit and tag, but do not push.
      --before-commit <cmd>
                      Run <cmd> through the shell after the version is written
                      and before the commit; everything it changes is committed
                      too. Sees RELEASE_VERSION, RELEASE_PREV_VERSION,
                      RELEASE_TAG and RELEASE_MANIFEST in its environment.
                      Non-zero exit aborts the release and restores the bump.
  --                  Treat all remaining arguments as message text.

Examples:
  release patch
  release minor "Added new feature"
  release 1.2.3-rc.1 --yes
  release --dry-run major
  release patch --tag-prefix "" --no-push
  release minor --before-commit "npm run build"`;
}

/**
 * Parses CLI arguments.
 *
 * Unlike 1.x, an unrecognized `-`-prefixed token is a hard error rather than
 * silently becoming commit-message text.
 *
 * @throws on an unknown option or a missing option value.
 */
function parseArgs(argv: string[]): ParsedArgs {
	const rest: string[] = [];
	let skipPrompts = false;
	let dryRun = false;
	let verbose = false;
	let help = false;
	let tagPrefix = "v";
	let push = true;
	let beforeCommit: string | null = null;

	// One hook only: a second occurrence is more likely a mistake (two tasks
	// composing flags) than an intent to run both, and the order would be
	// implicit. `&&` makes the order explicit and keeps a single code path.
	const setBeforeCommit = (cmd: string) => {
		if (beforeCommit !== null) {
			throw new Error(
				`Option '--before-commit' may be given only once (chain commands with '&&').`,
			);
		}
		if (!cmd.trim()) {
			throw new Error(`Option '--before-commit' requires a non-empty command.`);
		}
		beforeCommit = cmd;
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			rest.push(...argv.slice(i + 1));
			break;
		} else if (a === "--yes" || a === "-y") skipPrompts = true;
		else if (a === "--dry-run" || a === "-n") dryRun = true;
		else if (a === "--verbose") verbose = true;
		else if (a === "--help" || a === "-h") help = true;
		else if (a === "--no-push") push = false;
		else if (a === "--tag-prefix") {
			if (i + 1 >= argv.length) {
				throw new Error(
					`Option '--tag-prefix' requires a value (use '' for no prefix).`,
				);
			}
			tagPrefix = argv[++i];
		} else if (a.startsWith("--tag-prefix=")) {
			tagPrefix = a.slice("--tag-prefix=".length);
		} else if (a === "--before-commit") {
			if (i + 1 >= argv.length) {
				throw new Error(
					`Option '--before-commit' requires a value (a shell command).`,
				);
			}
			setBeforeCommit(argv[++i]);
		} else if (a.startsWith("--before-commit=")) {
			setBeforeCommit(a.slice("--before-commit=".length));
		} else if (a.startsWith("-") && a !== "-") {
			throw unknownFlagError(a);
		} else rest.push(a);
	}

	const [firstArg, ...messageParts] = rest;
	let spec: VersionSpec;
	let customMessage: string;

	if (firstArg && VALID_VERSION_TYPES.includes(firstArg as VersionType)) {
		spec = { kind: "bump", type: firstArg as VersionType };
		customMessage = messageParts.join(" ");
	} else if (firstArg && SEMVER_RE.test(firstArg)) {
		spec = { kind: "exact", version: firstArg };
		customMessage = messageParts.join(" ");
	} else {
		spec = { kind: "bump", type: "patch" };
		customMessage = firstArg ? [firstArg, ...messageParts].join(" ") : "";
		if (firstArg && looksLikeVersionType(firstArg)) {
			console.warn(
				yellow(
					`Warning: '${firstArg}' is not a valid version type. ` +
						`Treating it as part of the commit message and defaulting to 'patch'.`,
				),
			);
		}
	}
	return {
		spec,
		customMessage,
		skipPrompts,
		dryRun,
		verbose,
		help,
		tagPrefix,
		push,
		beforeCommit,
	};
}

/** A manifest file that exists, parses, and carries a string `version`. */
interface ResolvedManifest {
	path: string;
	text: string;
	data: Record<string, unknown>;
	version: string;
	/** Every candidate present in the cwd, in preference order. */
	candidates: string[];
}

/**
 * Locates the manifest to bump: the first existing candidate that carries a
 * string `version` field. Skipping version-less candidates matters for repos
 * that keep a `deno.json` purely for tasks / imports next to a versioned
 * `package.json`.
 *
 * Exits the process (CLI-only path) when nothing usable is found or when a
 * candidate exists but is not valid JSON.
 */
async function resolveManifest(): Promise<ResolvedManifest> {
	const candidates: string[] = [];
	for (const name of MANIFEST_CANDIDATES) {
		if (await fileExists(name)) candidates.push(name);
	}

	if (!candidates.length) {
		console.error(
			red(
				`Error: No manifest found (looked for ${MANIFEST_CANDIDATES.join(", ")})`,
			),
		);
		Deno.exit(1);
	}

	for (const path of candidates) {
		const text = await Deno.readTextFile(path);
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(text);
		} catch (e) {
			console.error(
				red(`Error: Failed to parse ${path}: ${(e as Error).message}`),
			);
			Deno.exit(1);
		}
		const version = data.version;
		if (typeof version !== "string") continue;
		return { path, text, data, version, candidates };
	}

	console.error(
		red(
			`Error: No string 'version' field found in ${candidates.join(" / ")}`,
		),
	);
	Deno.exit(1);
}

/**
 * Main entry point for the release CLI.
 *
 * Performs the following steps:
 * 1. Parses CLI args (version spec, message, `--yes`, `--dry-run`, `--verbose`,
 *    `--help`, `--tag-prefix`, `--no-push`, `--before-commit`); unknown
 *    options are rejected
 * 2. Validates git repository + manifest existence
 * 3. Checks for uncommitted changes (whole repo, untracked files included)
 * 4. Warns if not on main/master branch
 * 5. Pre-flight: tag must not already exist, `origin` must be configured, and
 *    `package-lock.json` (npm projects only) must be parseable
 * 6. Shows preview and asks for confirmation (unless `--yes` / `--dry-run`)
 * 7. Updates version in the manifest (preserving original indentation), and
 *    syncs `package-lock.json` when the manifest is a `package.json`
 * 8. Runs the `--before-commit` command, if given; on failure restores the
 *    files written in step 7 and aborts
 * 9. Stages the manifest (+ lockfile) — or, with `--before-commit`, the whole
 *    tree — then creates the commit and annotated tag
 * 10. Pushes the commit and the new tag to `origin`
 */
async function main(): Promise<void> {
	let args: ParsedArgs;
	try {
		args = parseArgs(Deno.args);
	} catch (e) {
		console.error(red(`Error: ${(e as Error).message}`));
		Deno.exit(1);
	}
	const {
		spec,
		customMessage,
		skipPrompts,
		dryRun,
		verbose,
		tagPrefix,
		push,
		beforeCommit,
	} = args;
	VERBOSE = verbose;

	if (args.help) {
		console.log(usage());
		return;
	}

	// Check if we're in a git repository (works for submodules too)
	const { code: gitCheck } = await run([
		"git",
		"rev-parse",
		"--is-inside-work-tree",
	]);
	if (gitCheck !== 0) {
		console.error(red("Error: Not in a git repository"));
		Deno.exit(1);
	}

	// Locate & parse manifest
	const {
		path: manifestPath,
		text: manifestText,
		data: manifest,
		version: currentVersion,
		candidates,
	} = await resolveManifest();

	// Check for uncommitted changes — allowed in dry-run so preview still works.
	// Untracked files are requested explicitly: `status.showUntrackedFiles=no`
	// would otherwise hide them here while `git add -A` (used with
	// --before-commit) would still sweep them into the release commit.
	const { stdout: status } = await run([
		"git",
		"status",
		"--porcelain",
		"--untracked-files=normal",
	]);
	if (status) {
		if (dryRun) {
			console.warn(
				yellow(
					"Warning: uncommitted changes present (ignored because of --dry-run).",
				),
			);
		} else {
			console.error(
				red(
					"Error: You have uncommitted changes. Please commit all changes before releasing.",
				),
			);
			const { stdout: shortStatus } = await run(["git", "status", "--short"]);
			console.log(shortStatus);
			Deno.exit(1);
		}
	}

	// Branch check
	const currentBranch = await runOrExit([
		"git",
		"rev-parse",
		"--abbrev-ref",
		"HEAD",
	]);
	if (currentBranch !== "main" && currentBranch !== "master") {
		console.log(
			yellow(
				`Warning: You're not on main/master branch (current: ${currentBranch})`,
			),
		);
		if (!skipPrompts && !dryRun) {
			const answer = prompt("Continue anyway? (y/N):");
			if (answer?.toLowerCase() !== "y") {
				Deno.exit(1);
			}
		}
	}

	console.log(`Manifest:        ${manifestPath}`);
	const others = candidates.filter((c) => c !== manifestPath);
	if (others.length) {
		console.log(
			yellow(`                 (also present, not updated: ${others.join(", ")})`),
		);
	}
	console.log(`Current version: ${currentVersion}`);

	// Compute new version (may throw on malformed current)
	let newVersion: string;
	if (spec.kind === "exact") {
		newVersion = spec.version;
		if (newVersion === currentVersion) {
			console.error(
				red(`Error: ${newVersion} is already the current version.`),
			);
			Deno.exit(1);
		}
	} else {
		try {
			newVersion = bumpVersion(currentVersion, spec.type);
		} catch (e) {
			console.error(red(`Error: ${(e as Error).message}`));
			Deno.exit(1);
		}
	}
	const tagName = `${tagPrefix}${newVersion}`;

	// ----- Pre-flight checks (all read-only; fail before any mutation) -----

	// Tag must not already exist locally
	const { code: tagExistsLocal } = await run([
		"git",
		"rev-parse",
		"-q",
		"--verify",
		`refs/tags/${tagName}`,
	]);
	if (tagExistsLocal === 0) {
		console.error(red(`Error: Tag ${tagName} already exists locally.`));
		Deno.exit(1);
	}

	// An 'origin' remote must be configured (we push to it later)
	if (push) {
		const { code: remoteCode, stderr: remoteErr } = await run([
			"git",
			"remote",
			"get-url",
			"origin",
		]);
		if (remoteCode !== 0) {
			console.error(red(`Error: No 'origin' remote configured.`));
			if (remoteErr) console.error(remoteErr);
			console.error(
				yellow("       (use --no-push to commit and tag without pushing)"),
			);
			Deno.exit(1);
		}
	}

	// npm lockfile must be parseable *before* we touch anything — `npm ci`
	// refuses to run when the lockfile disagrees with package.json, so bumping
	// the manifest alone would break CI for the repo we just released.
	let lockPath: string | null = null;
	let lockText = "";
	if (manifestPath === NPM_MANIFEST && await fileExists(NPM_LOCKFILE)) {
		// `git add` fails on ignored paths — catch that here rather than mid-release
		const { code: isIgnored } = await run([
			"git",
			"check-ignore",
			"-q",
			NPM_LOCKFILE,
		]);
		if (isIgnored === 0) {
			console.log(
				yellow(
					`Warning: ${NPM_LOCKFILE} is git-ignored — leaving it untouched.`,
				),
			);
		} else {
			lockText = await Deno.readTextFile(NPM_LOCKFILE);
			try {
				JSON.parse(lockText);
			} catch (e) {
				console.error(
					red(`Error: Failed to parse ${NPM_LOCKFILE}: ${
						(e as Error).message
					}`),
				);
				Deno.exit(1);
			}
			lockPath = NPM_LOCKFILE;
		}
	}

	// Build messages
	const commitMessage = customMessage
		? `Release: ${newVersion} (${customMessage})`
		: `Release: ${newVersion}`;

	// Preview
	console.log();
	console.log(dryRun ? "This WOULD (dry run):" : "This will:");
	console.log(
		`  - Set version to ${green(newVersion)} in ${manifestPath} ${
			dim(spec.kind === "exact" ? "(exact)" : `(${bold(spec.type)} bump)`)
		}`,
	);
	if (lockPath) {
		console.log(`  - Sync the root version in ${lockPath}`);
	}
	if (beforeCommit) {
		console.log(
			`  - Run before commit: ${beforeCommit} ${
				dim("(and stage whatever it changes)")
			}`,
		);
	}
	console.log(`  - Create a git commit: '${commitMessage}'`);
	console.log(`  - Create an annotated git tag: '${tagName}'`);
	if (push) {
		console.log(`  - Push the commit and the '${tagName}' tag to 'origin'`);
	} else {
		console.log(dim(`  - (not pushing — --no-push)`));
	}
	console.log();

	if (dryRun) {
		console.log(yellow("Dry run — no changes made."));
		return;
	}

	if (!skipPrompts) {
		const answer = prompt("Continue? (y/N):");
		if (answer?.toLowerCase() !== "y") {
			console.log("Release cancelled.");
			Deno.exit(0);
		}
	}

	// ----- Mutations -----

	console.log(`Setting version to ${newVersion}...`);
	manifest.version = newVersion;
	await Deno.writeTextFile(manifestPath, serializeLike(manifestText, manifest));

	let lockWritten = false;
	if (lockPath) {
		const patched = syncPackageLockVersion(lockText, newVersion);
		if (patched === lockText) {
			console.log(
				yellow(`Warning: no root 'version' field in ${lockPath} — left as is.`),
			);
		} else {
			await Deno.writeTextFile(lockPath, patched);
			lockWritten = true;
		}
	}

	// The hook runs with the bumped manifest on disk and nothing staged, so a
	// build here embeds the new version and lands in the tagged commit.
	if (beforeCommit) {
		console.log(`Running before-commit command: ${beforeCommit}`);
		const { code, signal } = await runShellInherited(beforeCommit, {
			RELEASE_VERSION: newVersion,
			RELEASE_PREV_VERSION: currentVersion,
			RELEASE_TAG: tagName,
			RELEASE_MANIFEST: manifestPath,
		});
		if (code !== 0) {
			const how = signal ? `killed by ${signal}` : `exit ${code}`;
			console.error(
				red(`Error: --before-commit command failed (${how}): ${beforeCommit}`),
			);
			// Restore exactly what *we* wrote; anything the command left behind
			// is the user's to inspect — `git clean` would be guesswork.
			const written = lockWritten && lockPath
				? [manifestPath, lockPath]
				: [manifestPath];
			try {
				await Deno.writeTextFile(manifestPath, manifestText);
				if (lockWritten && lockPath) await Deno.writeTextFile(lockPath, lockText);
				console.error(`Restored ${written.join(" and ")}.`);
			} catch (e) {
				console.error(
					yellow(
						`Could not restore ${written.join(" and ")}: ${
							(e as Error).message
						}`,
					),
				);
				console.error(
					`  git checkout HEAD -- ${
						written.join(" ")
					}   # discard the version bump`,
				);
			}
			console.error(
				"Files the command created or changed were left alone — see `git status`.",
			);
			Deno.exit(1);
		}
	}

	try {
		if (beforeCommit) {
			// Pre-flight required a clean tree (untracked files included), so
			// the only changes here are the bump and the hook's output.
			await runOrThrow(["git", "add", "-A"]);
		} else {
			await runOrThrow(["git", "add", manifestPath]);
			if (lockPath) await runOrThrow(["git", "add", lockPath]);
		}
		await runOrThrow(["git", "commit", "-m", commitMessage]);
		await runOrThrow(["git", "tag", "-a", tagName, "-m", commitMessage]);

		console.log(`Version bumped to: ${green(tagName)}`);

		if (push) {
			console.log("Pushing to remote...");
			await runOrThrow(["git", "push"]);
			await runOrThrow(["git", "push", "origin", `refs/tags/${tagName}`]);
		}
	} catch (e) {
		console.error(red(`Error: ${(e as Error).message}`));
		console.error();
		console.error(
			yellow(
				"You may be in a partially-released state. To inspect / roll back, consider:",
			),
		);
		console.error(`  git tag -d ${tagName}     # remove local tag if created`);
		console.error(`  git reset --hard HEAD~1   # undo local commit if created`);
		// `HEAD` (not the index) so the hint also undoes a successful `git add`
		// when the commit itself failed. With --before-commit the tree holds the
		// hook's output too, hence `.`; new untracked files survive a checkout.
		if (beforeCommit) {
			console.error(
				`  git checkout HEAD -- .    # discard the uncommitted bump and build output (new files: see git status)`,
			);
		} else {
			console.error(
				`  git checkout HEAD -- ${manifestPath}${
					lockPath ? ` ${lockPath}` : ""
				}   # discard the version bump if it was not yet committed`,
			);
		}
		Deno.exit(1);
	}

	console.log(green(`Release complete! New version: ${tagName}`));
	if (!push) {
		console.log(
			yellow(
				`Not pushed. When ready:  git push && git push origin refs/tags/${tagName}`,
			),
		);
	}
}

if (import.meta.main) {
	main();
}
