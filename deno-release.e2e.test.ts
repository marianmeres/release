// End-to-end tests: run the CLI inside a throwaway git repo with a local bare
// "origin", so the full mutate + commit + tag + push path is exercised.

const CLI = new URL("./deno-release.ts", import.meta.url).pathname;

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
