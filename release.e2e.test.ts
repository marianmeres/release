// End-to-end tests: run the CLI inside a throwaway git repo with a local bare
// "origin", so the full mutate + commit + tag + push path is exercised.

const CLI = new URL("./release.ts", import.meta.url).pathname;

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) {
		throw new Error(`${msg ? msg + ": " : ""}expected ${b}, got ${a}`);
	}
}

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const { code, stderr } = await new Deno.Command("git", {
		args,
		cwd,
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (code !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
		);
	}
}

/** Create a temp git repo (with a bare origin) seeded with `files`. */
async function makeRepo(files: Record<string, string>): Promise<string> {
	const root = await Deno.makeTempDir({ prefix: "deno-release-test-" });
	const repo = `${root}/repo`;
	const remote = `${root}/remote.git`;
	await Deno.mkdir(repo);
	await git(root, "init", "--bare", remote);
	await git(repo, "init", "-b", "main");
	await git(repo, "config", "user.email", "test@example.com");
	await git(repo, "config", "user.name", "Test");
	for (const [name, content] of Object.entries(files)) {
		await Deno.writeTextFile(`${repo}/${name}`, content);
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
	const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
		args: ["run", "-A", CLI, ...args],
		cwd,
		stdout: "piped",
		stderr: "piped",
	}).output();
	const dec = new TextDecoder();
	return { code, out: dec.decode(stdout) + dec.decode(stderr) };
}

const PKG_TABS =
	`{\n\t"name": "@scope/app",\n\t"version": "2.0.1",\n\t"private": true\n}\n`;
const LOCK_TABS =
	`{\n\t"name": "@scope/app",\n\t"version": "2.0.1",\n\t"lockfileVersion": 3,\n\t"packages": {\n\t\t"": {\n\t\t\t"name": "@scope/app",\n\t\t\t"version": "2.0.1"\n\t\t}\n\t}\n}\n`;

Deno.test("resolution order: deno.json wins over jsr.json wins over package.json", async () => {
	const repo = await makeRepo({
		"deno.json": `{\n  "version": "1.0.0"\n}\n`,
		"jsr.json": `{\n  "version": "2.0.0"\n}\n`,
		"package.json": PKG_TABS,
	});
	const { code, out } = await release(repo, "--dry-run", "patch");
	assertEquals(code, 0, out);
	assert(/Manifest:\s+deno\.json/.test(out), `deno.json not chosen:\n${out}`);
	assert(out.includes("1.0.1"), `wrong version computed:\n${out}`);
	assert(
		out.includes("also present, not updated") && out.includes("jsr.json"),
		`missing ambiguity note:\n${out}`,
	);
});

Deno.test("resolution skips a version-less deno.json in favour of package.json", async () => {
	const repo = await makeRepo({
		"deno.json": `{\n  "tasks": { "dev": "vite" }\n}\n`,
		"package.json": PKG_TABS,
	});
	const { code, out } = await release(repo, "--dry-run", "minor");
	assertEquals(code, 0, out);
	assert(/Manifest:\s+package\.json/.test(out), `package.json not chosen:\n${out}`);
	assert(out.includes("2.1.0"), `wrong version computed:\n${out}`);
});

Deno.test("npm release bumps package.json + lockfile, preserving tabs", async () => {
	const repo = await makeRepo({
		"package.json": PKG_TABS,
		"package-lock.json": LOCK_TABS,
	});
	const { code, out } = await release(repo, "--yes", "patch");
	assertEquals(code, 0, out);

	const pkgText = await Deno.readTextFile(`${repo}/package.json`);
	assertEquals(JSON.parse(pkgText).version, "2.0.2");
	assertEquals(JSON.parse(pkgText).private, true, "unrelated fields survive");
	assert(pkgText.includes('\n\t"name"'), `tabs lost in package.json:\n${pkgText}`);
	assert(pkgText.endsWith("}\n"), "trailing newline lost in package.json");

	const lockText = await Deno.readTextFile(`${repo}/package-lock.json`);
	const lock = JSON.parse(lockText);
	assertEquals(lock.version, "2.0.2");
	assertEquals(lock.packages[""].version, "2.0.2");
	assert(lockText.includes('\n\t"name"'), `tabs lost in lockfile:\n${lockText}`);

	// tree is clean (both files were committed) and the tag exists
	const status = await new Deno.Command("git", {
		args: ["status", "--porcelain"],
		cwd: repo,
		stdout: "piped",
	}).output();
	assertEquals(new TextDecoder().decode(status.stdout).trim(), "");
	const tag = await new Deno.Command("git", {
		args: ["rev-parse", "-q", "--verify", "refs/tags/v2.0.2"],
		cwd: repo,
		stdout: "piped",
		stderr: "piped",
	}).output();
	assertEquals(tag.code, 0, "tag v2.0.2 was not created");
});

Deno.test("unparseable lockfile fails pre-flight with nothing mutated", async () => {
	const repo = await makeRepo({
		"package.json": PKG_TABS,
		"package-lock.json": `{ "version": "2.0.1", oops }\n`,
	});
	const { code, out } = await release(repo, "--yes", "patch");
	assertEquals(code, 1, out);
	assert(out.includes("package-lock.json"), `unhelpful error:\n${out}`);

	assertEquals(
		JSON.parse(await Deno.readTextFile(`${repo}/package.json`)).version,
		"2.0.1",
		"manifest was mutated despite pre-flight failure",
	);
	const log = await new Deno.Command("git", {
		args: ["log", "--oneline"],
		cwd: repo,
		stdout: "piped",
	}).output();
	assertEquals(
		new TextDecoder().decode(log.stdout).trim().split("\n").length,
		1,
		"a commit was created despite pre-flight failure",
	);
});

Deno.test("absent lockfile is a silent no-op", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "patch");
	assertEquals(code, 0, out);
	assert(!out.includes("package-lock.json"), `unexpected lockfile chatter:\n${out}`);
	assertEquals(
		JSON.parse(await Deno.readTextFile(`${repo}/package.json`)).version,
		"2.0.2",
	);
});

Deno.test("deno.json release leaves package-lock.json alone", async () => {
	const repo = await makeRepo({
		"deno.json": `{\n  "version": "1.0.0"\n}\n`,
		"package.json": PKG_TABS,
		"package-lock.json": LOCK_TABS,
	});
	const { code, out } = await release(repo, "--yes", "patch");
	assertEquals(code, 0, out);
	assertEquals(await Deno.readTextFile(`${repo}/package-lock.json`), LOCK_TABS);
	assertEquals(await Deno.readTextFile(`${repo}/package.json`), PKG_TABS);
});

Deno.test("git-ignored lockfile is warned about, not staged", async () => {
	const repo = await makeRepo({
		"package.json": PKG_TABS,
		".gitignore": "package-lock.json\n",
	});
	await Deno.writeTextFile(`${repo}/package-lock.json`, LOCK_TABS);
	const { code, out } = await release(repo, "--yes", "patch");
	assertEquals(code, 0, out);
	assert(out.includes("git-ignored"), `missing warning:\n${out}`);
	assertEquals(
		await Deno.readTextFile(`${repo}/package-lock.json`),
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
	const version = JSON.parse(await Deno.readTextFile(`${repo}/package.json`)).version;
	const log = await new Deno.Command("git", {
		args: ["rev-list", "--count", "HEAD"],
		cwd: repo,
		stdout: "piped",
	}).output();
	return { version, commits: Number(new TextDecoder().decode(log.stdout).trim()) };
}

async function tagsIn(dir: string): Promise<string[]> {
	const { stdout } = await new Deno.Command("git", {
		args: ["tag", "-l"],
		cwd: dir,
		stdout: "piped",
	}).output();
	return new TextDecoder().decode(stdout).trim().split("\n").filter(Boolean);
}

Deno.test("unknown option is a hard error, nothing mutated", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);
	const { code, out } = await release(repo, "--yes", "--bogus");
	assertEquals(code, 1, out);
	assert(out.includes("Unknown option '--bogus'"), `unhelpful error:\n${out}`);
	assertEquals(await state(repo), before, "state changed despite a rejected flag");
});

Deno.test("unknown option offers a did-you-mean", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--dry-runn");
	assertEquals(code, 1, out);
	assert(out.includes("--dry-run"), `no suggestion offered:\n${out}`);
});

Deno.test("retired 1.x flags explain themselves instead of becoming message text", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);

	// the dangerous one: -v meant *version* in the legacy npm CLI, *verbose* here
	const v = await release(repo, "--yes", "-v", "1.2.3");
	assertEquals(v.code, 1, v.out);
	assert(v.out.includes("--verbose"), `no --verbose hint:\n${v.out}`);
	assert(v.out.includes("positional"), `no positional hint:\n${v.out}`);

	for (const flag of ["-d", "--suffix", "--git-tag-prefix"]) {
		const r = await release(repo, "--yes", flag, "x");
		assertEquals(r.code, 1, `${flag} was not rejected:\n${r.out}`);
	}
	assertEquals(await state(repo), before, "a retired flag mutated the repo");
});

Deno.test("--help prints usage and changes nothing", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const before = await state(repo);
	const { code, out } = await release(repo, "--help");
	assertEquals(code, 0, out);
	assert(out.includes("Usage:"), `no usage block:\n${out}`);
	assert(out.includes("--tag-prefix"), `usage omits --tag-prefix:\n${out}`);
	assertEquals(await state(repo), before);
});

Deno.test("-- passes the rest through as message text", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "patch", "--", "--bogus", "note");
	assertEquals(code, 0, out);
	const { stdout } = await new Deno.Command("git", {
		args: ["log", "-1", "--pretty=%s"],
		cwd: repo,
		stdout: "piped",
	}).output();
	assertEquals(
		new TextDecoder().decode(stdout).trim(),
		"Release: 2.0.2 (--bogus note)",
	);
});

Deno.test("exact version is used verbatim", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "3.1.4", "jumped ahead");
	assertEquals(code, 0, out);
	assertEquals((await state(repo)).version, "3.1.4");
	assert((await tagsIn(repo)).includes("v3.1.4"), "tag v3.1.4 missing");
});

Deno.test("exact prerelease version is accepted, and a later bump promotes it", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const rc = await release(repo, "--yes", "3.0.0-rc.1");
	assertEquals(rc.code, 0, rc.out);
	assertEquals((await state(repo)).version, "3.0.0-rc.1");
	assert((await tagsIn(repo)).includes("v3.0.0-rc.1"), "prerelease tag missing");

	// the reason bumpVersion understands prereleases: otherwise the repo would
	// be stuck here, with every keyword bump throwing "Invalid version format"
	const promoted = await release(repo, "--yes", "patch");
	assertEquals(promoted.code, 0, promoted.out);
	assertEquals((await state(repo)).version, "3.0.0");
});

Deno.test("exact version equal to the current one is refused", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "2.0.1");
	assertEquals(code, 1, out);
	assert(out.includes("already the current version"), `unclear error:\n${out}`);
});

Deno.test('--tag-prefix "" tags without a prefix', async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "patch", "--tag-prefix", "");
	assertEquals(code, 0, out);
	const tags = await tagsIn(repo);
	assert(tags.includes("2.0.2"), `expected unprefixed tag, got ${tags}`);
	assert(!tags.includes("v2.0.2"), "prefixed tag should not exist");
});

Deno.test("--tag-prefix without a value is an error", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const { code, out } = await release(repo, "--yes", "--tag-prefix");
	assertEquals(code, 1, out);
	assert(out.includes("requires a value"), `unclear error:\n${out}`);
});

Deno.test("--no-push commits and tags locally, leaving the remote untouched", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	const remote = `${repo}/../remote.git`;
	const { code, out } = await release(repo, "--yes", "patch", "--no-push");
	assertEquals(code, 0, out);

	assertEquals((await state(repo)).version, "2.0.2");
	assert((await tagsIn(repo)).includes("v2.0.2"), "local tag missing");
	assertEquals(await tagsIn(remote), [], "remote received tags despite --no-push");

	const behind = await new Deno.Command("git", {
		args: ["rev-list", "--count", "origin/main..HEAD"],
		cwd: repo,
		stdout: "piped",
	}).output();
	assertEquals(
		new TextDecoder().decode(behind.stdout).trim(),
		"1",
		"commit should be unpushed",
	);
	assert(out.includes("Not pushed"), `no reminder printed:\n${out}`);
});

Deno.test("--no-push works without an origin remote at all", async () => {
	const repo = await makeRepo({ "package.json": PKG_TABS });
	await git(repo, "remote", "remove", "origin");
	const { code, out } = await release(repo, "--yes", "patch", "--no-push");
	assertEquals(code, 0, out);
	assertEquals((await state(repo)).version, "2.0.2");
});
