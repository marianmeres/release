#!/usr/bin/env -S deno run -A

/**
 * @module
 * Opinionated CLI tool for releasing Deno / JSR projects.
 *
 * Bumps the version in `deno.json` (or `jsr.json`), creates an annotated git
 * tag, and pushes the commit together with the new tag to the remote
 * repository.
 *
 * Importing this module does not execute the CLI — library consumers can
 * safely import {@link bumpVersion} without side effects.
 *
 * @example
 * ```bash
 * deno run -A jsr:@marianmeres/deno-release              # defaults to patch
 * deno run -A jsr:@marianmeres/deno-release patch
 * deno run -A jsr:@marianmeres/deno-release minor "Added new feature"
 * deno run -A jsr:@marianmeres/deno-release --yes patch  # skip confirmations
 * deno run -A jsr:@marianmeres/deno-release --dry-run minor
 * ```
 */

/** Semantic version bump type. */
export type VersionType = "major" | "minor" | "patch";

const VALID_VERSION_TYPES: VersionType[] = ["major", "minor", "patch"];

/** Manifest file names searched, in order of preference. */
const MANIFEST_CANDIDATES = ["deno.json", "jsr.json"] as const;

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

/** Check whether a plain file exists at `path`. */
async function fileExists(path: string): Promise<boolean> {
	try {
		const stat = await Deno.stat(path);
		return stat.isFile;
	} catch {
		return false;
	}
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parses a semver string `X.Y.Z` into numeric components.
 * @throws on malformed input.
 */
function parseVersion(version: string): [number, number, number] {
	const m = SEMVER_RE.exec(version);
	if (!m) {
		throw new Error(
			`Invalid version format: ${
				JSON.stringify(version)
			} (expected "X.Y.Z" with non-negative integers)`,
		);
	}
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Bumps a semantic version based on the specified type.
 *
 * @throws if `current` is not a valid `X.Y.Z` semver string or `type` is not
 *         one of `"major" | "minor" | "patch"`.
 *
 * @example
 * ```ts
 * bumpVersion("1.2.3", "patch"); // "1.2.4"
 * bumpVersion("1.2.3", "minor"); // "1.3.0"
 * bumpVersion("1.2.3", "major"); // "2.0.0"
 * ```
 */
export function bumpVersion(current: string, type: VersionType): string {
	let [major, minor, patch] = parseVersion(current);
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

interface ParsedArgs {
	versionType: VersionType;
	customMessage: string;
	skipPrompts: boolean;
	dryRun: boolean;
	verbose: boolean;
}

function looksLikeVersionType(arg: string): boolean {
	if (arg.length > 10 || /\s/.test(arg)) return false;
	return /^(maj|mij|mjo|min|mni|pat|pth|pac|patc|majo|mino)/i.test(arg);
}

function parseArgs(argv: string[]): ParsedArgs {
	const rest: string[] = [];
	let skipPrompts = false;
	let dryRun = false;
	let verbose = false;
	for (const a of argv) {
		if (a === "--yes" || a === "-y") skipPrompts = true;
		else if (a === "--dry-run" || a === "-n") dryRun = true;
		else if (a === "--verbose" || a === "-v") verbose = true;
		else rest.push(a);
	}

	const [firstArg, ...messageParts] = rest;
	let versionType: VersionType;
	let customMessage: string;

	if (firstArg && VALID_VERSION_TYPES.includes(firstArg as VersionType)) {
		versionType = firstArg as VersionType;
		customMessage = messageParts.join(" ");
	} else {
		versionType = "patch";
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
	return { versionType, customMessage, skipPrompts, dryRun, verbose };
}

/** Locate the first available manifest file. Returns `null` if none found. */
async function findManifest(): Promise<string | null> {
	for (const name of MANIFEST_CANDIDATES) {
		if (await fileExists(name)) return name;
	}
	return null;
}

/**
 * Main entry point for the release CLI.
 *
 * Performs the following steps:
 * 1. Parses CLI args (`--yes`, `--dry-run`, `--verbose`, version type, msg)
 * 2. Validates git repository + manifest existence
 * 3. Checks for uncommitted changes
 * 4. Warns if not on main/master branch
 * 5. Pre-flight: tag must not already exist and `origin` must be configured
 * 6. Shows preview and asks for confirmation (unless `--yes` / `--dry-run`)
 * 7. Updates version in the manifest (preserving original indentation)
 * 8. Creates commit and annotated tag
 * 9. Pushes the commit and the new tag to `origin`
 */
async function main(): Promise<void> {
	const { versionType, customMessage, skipPrompts, dryRun, verbose } = parseArgs(
		Deno.args,
	);
	VERBOSE = verbose;

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

	// Locate manifest
	const manifestPath = await findManifest();
	if (!manifestPath) {
		console.error(
			red(
				`Error: No manifest found (looked for ${MANIFEST_CANDIDATES.join(", ")})`,
			),
		);
		Deno.exit(1);
	}

	// Check for uncommitted changes — allowed in dry-run so preview still works
	const { stdout: status } = await run(["git", "status", "--porcelain"]);
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

	// Read & parse manifest
	const manifestText = await Deno.readTextFile(manifestPath);
	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(manifestText);
	} catch (e) {
		console.error(
			red(`Error: Failed to parse ${manifestPath}: ${(e as Error).message}`),
		);
		Deno.exit(1);
	}
	const currentVersion = manifest.version;
	if (typeof currentVersion !== "string") {
		console.error(
			red(`Error: No string 'version' field found in ${manifestPath}`),
		);
		Deno.exit(1);
	}
	console.log(`Manifest:        ${manifestPath}`);
	console.log(`Current version: ${currentVersion}`);

	// Compute new version (may throw on malformed current)
	let newVersion: string;
	try {
		newVersion = bumpVersion(currentVersion, versionType);
	} catch (e) {
		console.error(red(`Error: ${(e as Error).message}`));
		Deno.exit(1);
	}
	const tagName = `v${newVersion}`;

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
	const { code: remoteCode, stderr: remoteErr } = await run([
		"git",
		"remote",
		"get-url",
		"origin",
	]);
	if (remoteCode !== 0) {
		console.error(red(`Error: No 'origin' remote configured.`));
		if (remoteErr) console.error(remoteErr);
		Deno.exit(1);
	}

	// Build messages
	const commitMessage = customMessage
		? `Release: ${newVersion} (${customMessage})`
		: `Release: ${newVersion}`;

	// Preview
	console.log();
	console.log(dryRun ? "This WOULD (dry run):" : "This will:");
	console.log(
		`  - Bump ${bold(versionType)} version to ${
			green(newVersion)
		} in ${manifestPath}`,
	);
	console.log(`  - Create a git commit: '${commitMessage}'`);
	console.log(`  - Create an annotated git tag: '${tagName}'`);
	console.log(`  - Push the commit and the '${tagName}' tag to 'origin'`);
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

	console.log(`Bumping ${versionType} version...`);
	manifest.version = newVersion;
	const indent = detectIndent(manifestText);
	const trailingNewline = manifestText.endsWith("\n") ? "\n" : "";
	const serialized = JSON.stringify(manifest, null, indent) + trailingNewline;
	await Deno.writeTextFile(manifestPath, serialized);

	try {
		await runOrThrow(["git", "add", manifestPath]);
		await runOrThrow(["git", "commit", "-m", commitMessage]);
		await runOrThrow(["git", "tag", "-a", tagName, "-m", commitMessage]);

		console.log(`Version bumped to: ${green(tagName)}`);

		console.log("Pushing to remote...");
		await runOrThrow(["git", "push"]);
		await runOrThrow(["git", "push", "origin", `refs/tags/${tagName}`]);
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
		console.error(`  (no-op on ${manifestPath} if it was not yet committed)`);
		Deno.exit(1);
	}

	console.log(green(`Release complete! New version: ${tagName}`));
}

if (import.meta.main) {
	main();
}
