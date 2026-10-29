// End-to-end tests: run the CLI inside a throwaway git repo with a local bare
// "origin", so the full mutate + commit + tag + push path is exercised.
//
// The CLI runs on Node from source. `CLI_RUNTIME=deno` runs it on Deno instead
// (`pnpm run test:deno`), which is how the JSR consumers execute it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/release.ts", import.meta.url));

/** How the CLI is started: Node by default, Deno under `CLI_RUNTIME=deno`. */
const CLI_ARGV: [string, ...string[]] =
	process.env.CLI_RUNTIME === "deno"
		? ["deno", "run", "-A", CLI]
		: [process.execPath, CLI];

/** Spawn `file args` in `cwd`; resolves with the exit code and captured output. */
function exec(
	cwd: string,
	file: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
		child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

/** Run git in `cwd`; throws on a non-zero exit, returns trimmed stdout. */
async function gitOut(cwd: string, ...args: string[]): Promise<string> {
	const { code, stdout, stderr } = await exec(cwd, "git", args);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	return stdout.trim();
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	await gitOut(cwd, ...args);
}

const read = (path: string): Promise<string> => readFile(path, "utf8");

/** Create a temp git repo (with a bare origin) seeded with `files`. */
async function makeRepo(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "release-test-"));
	const repo = `${root}/repo`;
	const remote = `${root}/remote.git`;
	await mkdir(repo);
	await git(root, "init", "--bare", remote);
	await git(repo, "init", "-b", "main");
	await git(repo, "config", "user.email", "test@example.com");
	await git(repo, "config", "user.name", "Test");
	for (const [name, content] of Object.entries(files)) {
		await writeFile(`${repo}/${name}`, content);
	}
	await git(repo, "add", ".");
	await git(repo, "commit", "-m", "init");
	await git(repo, "remote", "add", "origin", remote);
	await git(repo, "push", "-u", "origin", "main");
	return repo;
}

async function release(
	cwd: string,
	...args: string[]
): Promise<{ code: number; out: string }> {
	const [file, ...pre] = CLI_ARGV;
	const { code, stdout, stderr } = await exec(cwd, file, [...pre, ...args]);
	return { code, out: stdout + stderr };
}

const PKG_TABS = `{\n\t"name": "@scope/app",\n\t"version": "2.0.1",\n\t"private": true\n}\n`;
const LOCK_TABS = `{\n\t"name": "@scope/app",\n\t"version": "2.0.1",\n\t"lockfileVersion": 3,\n\t"packages": {\n\t\t"": {\n\t\t\t"name": "@scope/app",\n\t\t\t"version": "2.0.1"\n\t\t}\n\t}\n}\n`;

test("resolution order: deno.json wins over jsr.json wins over package.json", async () => {
	const repo = await makeRepo({
		"deno.json": `{\n  "version": "1.0.0"\n}\n`,
		"jsr.json": `{\n  "version": "2.0.0"\n}\n`,
		"package.json": PKG_TABS,
	});
	const { code, out } = await release(repo, "--dry-run", "patch");
	assert.deepEqual(code, 0, out);
	assert(/Manifest:\s+deno\.json/.test(out), `deno.json not chosen:\n${out}`);
	assert(out.includes("1.0.1"), `wrong version computed:\n${out}`);
	assert(
		out.includes("also present, not updated") && out.includes("jsr.json"),
		`missing ambiguity note:\n${out}`,
	);
});

test("resolution skips a version-less deno.json in favour of package.json", async () => {
	const repo = await makeRepo({
		"deno.json": `{\n  "tasks": { "dev": "vite" }\n}\n`,
		"package.json": PKG_TABS,
	});
	const { code, out } = await release(repo, "--dry-run", "minor");
	assert.deepEqual(code, 0, out);
	assert(/Manifest:\s+package\.json/.test(out), `package.json not chosen:\n${out}`);
	assert(out.includes("2.1.0"), `wrong version computed:\n${out}`);
});

test("npm release bumps package.json + lockfile, preserving tabs", async () => {
	const repo = await makeRepo({
		"package.json": PKG_TABS,
		"package-lock.json": LOCK_TABS,
	});
	const { code, out } = await release(repo, "--yes", "patch");
	assert.deepEqual(code, 0, out);

	const pkgText = await read(`${repo}/package.json`);
	assert.deepEqual(JSON.parse(pkgText).version, "2.0.2");
	assert.deepEqual(JSON.parse(pkgText).private, true, "unrelated fields survive");
	assert(pkgText.includes('\n\t"name"'), `tabs lost in package.json:\n${pkgText}`);
	assert(pkgText.endsWith("}\n"), "trailing newline lost in package.json");

	const lockText = await read(`${repo}/package-lock.json`);
	const lock = JSON.parse(lockText);
	assert.deepEqual(lock.version, "2.0.2");
	assert.deepEqual(lock.packages[""].version, "2.0.2");
	assert(lockText.includes('\n\t"name"'), `tabs lost in lockfile:\n${lockText}`);

	// tree is clean (both files were committed) and the tag exists
	assert.deepEqual(await gitOut(repo, "status", "--porcelain"), "");
	const tag = await exec(repo, "git", [
		"rev-parse",
		"-q",
		"--verify",
		"refs/tags/v2.0.2",
	]);
	assert.deepEqual(tag.code, 0, "tag v2.0.2 was not created");
});

test("unparseable lockfile fails pre-flight with nothing mutated", async () => {
	const repo = await makeRepo({
		"package.json": PKG_TABS,
		"package-lock.json": `{ "version": "2.0.1", oops }\n`,
	});
	const { code, out } = await release(repo, "--yes", "patch");
	assert.deepEqual(code, 1, out);
	assert(out.includes("package-lock.json"), `unhelpful error:\n${out}`);

	assert.deepEqual(
		JSON.parse(await read(`${repo}/package.json`)).version,
		"2.0.1",
		"manifest was mutated despite pre-flight failure",
	);
	const log = await gitOut(repo, "log", "--oneline");
	assert.deepEqual(
		log.split("\n").length,
		1,
		"a commit was created despite pre-flight failure",
	);
});

test("absent lockfile is a silent no-op", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "patch");
	assert.deepEqual(code, 0, out);
	assert(!out.includes("package-lock.json"), `unexpected lockfile chatter:\n${out}`);
	assert.deepEqual(JSON.parse(await read(`${repo}/package.json`)).version, "2.0.2");
});

test("deno.json release leaves package-lock.json alone", async () => {
	const repo = await makeRepo({
		"deno.json": `{\n  "version": "1.0.0"\n}\n`,
		"package.json": PKG_TABS,
		"package-lock.json": LOCK_TABS,
	});
	const { code, out } = await release(repo, "--yes", "patch");
	assert.deepEqual(code, 0, out);
	assert.deepEqual(await read(`${repo}/package-lock.json`), LOCK_TABS);
	assert.deepEqual(await read(`${repo}/package.json`), PKG_TABS);
});

test("git-ignored lockfile is warned about, not staged", async () => {
	const repo = await makeRepo({
		"package.json": PKG_TABS,
		".gitignore": "package-lock.json\n",
	});
	await writeFile(`${repo}/package-lock.json`, LOCK_TABS);
	const { code, out } = await release(repo, "--yes", "patch");
	assert.deepEqual(code, 0, out);
	assert(out.includes("git-ignored"), `missing warning:\n${out}`);
	assert.deepEqual(
		await read(`${repo}/package-lock.json`),
		LOCK_TABS,
		"ignored lockfile should be left untouched",
	);
});

// ---------------------------------------------------------------------------
// CLI surface (2.0.0). In 1.x every unrecognized token silently became commit
// message text, so a mistyped flag produced a real release with a weird message.
// ---------------------------------------------------------------------------

/** Version currently in package.json + the repo's commit count. */
async function state(repo: string): Promise<{ version: string; commits: number }> {
	const version = JSON.parse(await read(`${repo}/package.json`)).version;
	return {
		version,
		commits: Number(await gitOut(repo, "rev-list", "--count", "HEAD")),
	};
}

async function tagsIn(dir: string): Promise<string[]> {
	return (await gitOut(dir, "tag", "-l")).split("\n").filter(Boolean);
}

test("unknown option is a hard error, nothing mutated", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);
	const { code, out } = await release(repo, "--yes", "--bogus");
	assert.deepEqual(code, 1, out);
	assert(out.includes("Unknown option '--bogus'"), `unhelpful error:\n${out}`);
	assert.deepEqual(await state(repo), before, "state changed despite a rejected flag");
});

test("unknown option offers a did-you-mean", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--dry-runn");
	assert.deepEqual(code, 1, out);
	assert(out.includes("--dry-run"), `no suggestion offered:\n${out}`);
});

test("retired 1.x flags explain themselves instead of becoming message text", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);

	// the dangerous one: -v meant *version* in the legacy npm CLI, *verbose* here
	const v = await release(repo, "--yes", "-v", "1.2.3");
	assert.deepEqual(v.code, 1, v.out);
	assert(v.out.includes("--verbose"), `no --verbose hint:\n${v.out}`);
	assert(v.out.includes("positional"), `no positional hint:\n${v.out}`);

	for (const flag of ["-d", "--suffix", "--git-tag-prefix"]) {
		const r = await release(repo, "--yes", flag, "x");
		assert.deepEqual(r.code, 1, `${flag} was not rejected:\n${r.out}`);
	}
	assert.deepEqual(await state(repo), before, "a retired flag mutated the repo");
});

test("--help prints usage and changes nothing", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);
	const { code, out } = await release(repo, "--help");
	assert.deepEqual(code, 0, out);
	assert(out.includes("Usage:"), `no usage block:\n${out}`);
	assert(out.includes("--tag-prefix"), `usage omits --tag-prefix:\n${out}`);
	assert(out.includes("--before-commit"), `usage omits --before-commit:\n${out}`);
	assert.deepEqual(await state(repo), before);
});

test("-- passes the rest through as message text", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "patch", "--", "--bogus", "note");
	assert.deepEqual(code, 0, out);
	assert.deepEqual(
		await gitOut(repo, "log", "-1", "--pretty=%s"),
		"Release: 2.0.2 (--bogus note)",
	);
});

test("exact version is used verbatim", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "3.1.4", "jumped ahead");
	assert.deepEqual(code, 0, out);
	assert.deepEqual((await state(repo)).version, "3.1.4");
	assert((await tagsIn(repo)).includes("v3.1.4"), "tag v3.1.4 missing");
});

test("exact prerelease version is accepted, and a later bump promotes it", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const rc = await release(repo, "--yes", "3.0.0-rc.1");
	assert.deepEqual(rc.code, 0, rc.out);
	assert.deepEqual((await state(repo)).version, "3.0.0-rc.1");
	assert((await tagsIn(repo)).includes("v3.0.0-rc.1"), "prerelease tag missing");

	// the reason bumpVersion understands prereleases: otherwise the repo would
	// be stuck here, with every keyword bump throwing "Invalid version format"
	const promoted = await release(repo, "--yes", "patch");
	assert.deepEqual(promoted.code, 0, promoted.out);
	assert.deepEqual((await state(repo)).version, "3.0.0");
});

test("exact version equal to the current one is refused", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "2.0.1");
	assert.deepEqual(code, 1, out);
	assert(out.includes("already the current version"), `unclear error:\n${out}`);
});

test('--tag-prefix "" tags without a prefix', async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "patch", "--tag-prefix", "");
	assert.deepEqual(code, 0, out);
	const tags = await tagsIn(repo);
	assert(tags.includes("2.0.2"), `expected unprefixed tag, got ${tags}`);
	assert(!tags.includes("v2.0.2"), "prefixed tag should not exist");
});

test("--tag-prefix without a value is an error", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "--tag-prefix");
	assert.deepEqual(code, 1, out);
	assert(out.includes("requires a value"), `unclear error:\n${out}`);
});

test("--no-push commits and tags locally, leaving the remote untouched", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const remote = `${repo}/../remote.git`;
	const { code, out } = await release(repo, "--yes", "patch", "--no-push");
	assert.deepEqual(code, 0, out);

	assert.deepEqual((await state(repo)).version, "2.0.2");
	assert((await tagsIn(repo)).includes("v2.0.2"), "local tag missing");
	assert.deepEqual(await tagsIn(remote), [], "remote received tags despite --no-push");

	assert.deepEqual(
		await gitOut(repo, "rev-list", "--count", "origin/main..HEAD"),
		"1",
		"commit should be unpushed",
	);
	assert(out.includes("Not pushed"), `no reminder printed:\n${out}`);
});

test("--no-push works without an origin remote at all", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	await git(repo, "remote", "remove", "origin");
	const { code, out } = await release(repo, "--yes", "patch", "--no-push");
	assert.deepEqual(code, 0, out);
	assert.deepEqual((await state(repo)).version, "2.0.2");
});

// ---------------------------------------------------------------------------
// --before-commit (2.1.0): run a command between the version bump and the
// release commit, for repos that commit build artifacts embedding the version.
// Without it such an artifact is always built one commit *after* the tag.
// ---------------------------------------------------------------------------

/** Paths touched by the commit at `rev`, sorted. */
async function filesIn(repo: string, rev: string): Promise<string[]> {
	const out = await gitOut(
		repo,
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		rev,
	);
	return out.split("\n").filter(Boolean).sort();
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

test("--before-commit: the command's output lands in the tagged commit", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(
		repo,
		"--yes",
		"--verbose",
		"patch",
		"--before-commit",
		"cp package.json built.json",
	);
	assert.deepEqual(code, 0, out);

	// built from the *bumped* manifest — the whole point of the option
	const built = await gitOut(repo, "show", "HEAD:built.json");
	assert.deepEqual(JSON.parse(built).version, "2.0.2");
	assert.deepEqual(await filesIn(repo, "HEAD"), ["built.json", "package.json"]);
	assert.deepEqual(
		await gitOut(repo, "rev-parse", "v2.0.2^{commit}"),
		await gitOut(repo, "rev-parse", "HEAD"),
		"tag does not point at the release commit",
	);
	assert.deepEqual(await gitOut(repo, "status", "--porcelain"), "", "tree left dirty");

	assert(
		out.includes("Run before commit: cp package.json built.json"),
		`preview omits the command:\n${out}`,
	);
	assert(
		out.includes("$ sh -c 'cp package.json built.json'"),
		`no verbose trace:\n${out}`,
	);
	assert(out.includes("$ git add -A"), `whole tree not staged:\n${out}`);
});

test("--before-commit=<cmd> form behaves identically", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(
		repo,
		"--yes",
		"patch",
		"--before-commit=cp package.json built.json",
	);
	assert.deepEqual(code, 0, out);
	assert.deepEqual(
		JSON.parse(await gitOut(repo, "show", "HEAD:built.json")).version,
		"2.0.2",
	);
	assert.deepEqual(await filesIn(repo, "HEAD"), ["built.json", "package.json"]);
});

test("--before-commit: RELEASE_* env vars describe the release", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const cmd =
		'printf "%s|%s|%s|%s" "$RELEASE_VERSION" "$RELEASE_PREV_VERSION" "$RELEASE_TAG" "$RELEASE_MANIFEST" > env.txt';
	const { code, out } = await release(repo, "--yes", "patch", "--before-commit", cmd);
	assert.deepEqual(code, 0, out);
	assert.deepEqual(
		await gitOut(repo, "show", "HEAD:env.txt"),
		"2.0.2|2.0.1|v2.0.2|package.json",
	);
});

test("--before-commit: git-ignored output is not staged", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS, ".gitignore": "out/\n" });
	const { code, out } = await release(
		repo,
		"--yes",
		"patch",
		"--before-commit",
		"mkdir -p out && touch out/x",
	);
	assert.deepEqual(code, 0, out);
	assert(await exists(`${repo}/out/x`), "command did not run");
	assert.deepEqual(await filesIn(repo, "HEAD"), ["package.json"]);
	assert.deepEqual(
		await gitOut(repo, "status", "--porcelain"),
		"",
		"ignored output shows as dirty",
	);
});

test("--before-commit: the lockfile is synced before the command runs", async () => {
	// an npm build reading package-lock.json must already see the new version
	const repo = await makeRepo({
		"package.json": PKG_TABS,
		"package-lock.json": LOCK_TABS,
	});
	const { code, out } = await release(
		repo,
		"--yes",
		"patch",
		"--before-commit",
		"cp package-lock.json lock-copy.json",
	);
	assert.deepEqual(code, 0, out);
	assert.deepEqual(
		JSON.parse(await gitOut(repo, "show", "HEAD:lock-copy.json")).version,
		"2.0.2",
	);
	assert.deepEqual(await filesIn(repo, "HEAD"), [
		"lock-copy.json",
		"package-lock.json",
		"package.json",
	]);
});

test("--before-commit: a failing command aborts and restores the bump", async () => {
	const repo = await makeRepo({
		"package.json": PKG_TABS,
		"package-lock.json": LOCK_TABS,
	});
	const before = await state(repo);
	const { code, out } = await release(
		repo,
		"--yes",
		"patch",
		"--before-commit",
		"touch leftover.txt && exit 3",
	);
	assert.deepEqual(code, 1, out);
	assert(out.includes("exit 3"), `exit code not reported:\n${out}`);
	assert(out.includes("touch leftover.txt && exit 3"), `command not named:\n${out}`);
	assert(
		out.includes("Restored package.json and package-lock.json"),
		`restore not reported:\n${out}`,
	);

	// what the tool itself wrote is restored byte-for-byte …
	assert.deepEqual(await read(`${repo}/package.json`), PKG_TABS);
	assert.deepEqual(await read(`${repo}/package-lock.json`), LOCK_TABS);
	// … nothing was committed or tagged …
	assert.deepEqual(await state(repo), before);
	assert.deepEqual(await tagsIn(repo), []);
	// … and the command's own leftovers are the user's to inspect, not ours to clean
	assert(
		await exists(`${repo}/leftover.txt`),
		"tool must not delete the command's files",
	);
	assert(out.includes("git status"), `no pointer to leftovers:\n${out}`);
	assert.deepEqual(await gitOut(repo, "status", "--porcelain"), "?? leftover.txt");
});

test("--before-commit: --dry-run previews the command without running it", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);
	const { code, out } = await release(
		repo,
		"--dry-run",
		"patch",
		"--before-commit",
		"touch ran.txt",
	);
	assert.deepEqual(code, 0, out);
	assert(
		out.includes("Run before commit: touch ran.txt"),
		`preview omits the command:\n${out}`,
	);
	assert(!(await exists(`${repo}/ran.txt`)), "command ran under --dry-run");
	assert.deepEqual(await state(repo), before);
});

test("--before-commit without a value is an error, nothing mutated", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);
	const { code, out } = await release(repo, "--yes", "patch", "--before-commit");
	assert.deepEqual(code, 1, out);
	assert(out.includes("requires a value"), `unclear error:\n${out}`);
	assert.deepEqual(await state(repo), before);
});

test("--before-commit with an empty command is an error", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);
	const { code, out } = await release(repo, "--yes", "patch", "--before-commit", "  ");
	assert.deepEqual(code, 1, out);
	assert(out.includes("non-empty"), `unclear error:\n${out}`);
	assert.deepEqual(await state(repo), before);
});

test("--before-commit given twice is an error, nothing mutated", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);
	const { code, out } = await release(
		repo,
		"--yes",
		"patch",
		"--before-commit",
		"true",
		"--before-commit=true",
	);
	assert.deepEqual(code, 1, out);
	assert(out.includes("only once") && out.includes("&&"), `unclear error:\n${out}`);
	assert.deepEqual(await state(repo), before);
	assert.deepEqual(await tagsIn(repo), []);
});

test("--before-commit typo gets a did-you-mean", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--before-comit", "true");
	assert.deepEqual(code, 1, out);
	assert(out.includes("--before-commit"), `no suggestion offered:\n${out}`);
});

test("without --before-commit only the manifest is staged, never the whole tree", async () => {
	// In a clean tree both forms yield the same commit, so the verbose trace is
	// the evidence that the targeted `git add` path is still the default.
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "--verbose", "patch");
	assert.deepEqual(code, 0, out);
	assert(out.includes("$ git add package.json"), `targeted add missing:\n${out}`);
	assert(
		!out.includes("git add -A"),
		`whole tree staged without --before-commit:\n${out}`,
	);
	assert.deepEqual(await filesIn(repo, "HEAD"), ["package.json"]);
});

test("--before-commit: a later git failure widens the rollback hint to the whole tree", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	// pre-flight only asks for origin's URL; the push itself is what fails
	await git(repo, "remote", "set-url", "origin", `${repo}/../does-not-exist.git`);
	const { code, out } = await release(
		repo,
		"--yes",
		"patch",
		"--before-commit",
		"cp package.json built.json",
	);
	assert.deepEqual(code, 1, out);
	assert(out.includes("partially-released"), `no rollback hint:\n${out}`);
	assert(out.includes("git checkout HEAD -- ."), `hint not widened:\n${out}`);
	// the command did run and its output was committed before the push failed
	assert.deepEqual(await filesIn(repo, "HEAD"), ["built.json", "package.json"]);
});

test("clean check sees untracked files even under status.showUntrackedFiles=no", async () => {
	// `git status --porcelain` honours that setting; without an explicit
	// --untracked-files the stray file would pass pre-flight and then be swept
	// into the release commit by `git add -A`.
	const repo = await makeRepo({ "package.json": PKG_TABS });
	await git(repo, "config", "status.showUntrackedFiles", "no");
	await writeFile(`${repo}/stray.txt`, "oops\n");
	const before = await state(repo);
	const { code, out } = await release(
		repo,
		"--yes",
		"patch",
		"--before-commit",
		"true",
	);
	assert.deepEqual(code, 1, out);
	assert(out.includes("uncommitted changes"), `unclear error:\n${out}`);
	assert.deepEqual(await state(repo), before);
	assert.deepEqual(await tagsIn(repo), []);
});
