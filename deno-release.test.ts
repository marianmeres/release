import { bumpVersion, syncPackageLockVersion } from "./deno-release.ts";

// Kept dependency-free on purpose (see AGENTS.md: zero dependencies).
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) {
		throw new Error(`${msg ? msg + ": " : ""}expected ${b}, got ${a}`);
	}
}

function assertThrows(fn: () => unknown, msg?: string): void {
	try {
		fn();
	} catch {
		return;
	}
	throw new Error(msg ?? "expected function to throw");
}

Deno.test("bumpVersion", () => {
	assertEquals(bumpVersion("1.2.3", "patch"), "1.2.4");
	assertEquals(bumpVersion("1.2.3", "minor"), "1.3.0");
	assertEquals(bumpVersion("1.2.3", "major"), "2.0.0");
	assertEquals(bumpVersion("0.0.0", "patch"), "0.0.1");
	assertThrows(() => bumpVersion("not-semver", "patch"));
	assertThrows(() => bumpVersion("1.0.0-beta.1", "patch"));
	assertThrows(() => bumpVersion("1.2", "patch"));
});

Deno.test("syncPackageLockVersion: lockfileVersion 3 updates both fields", () => {
	const lock = JSON.stringify(
		{
			name: "@marianmeres/tempo",
			version: "2.0.1",
			lockfileVersion: 3,
			packages: {
				"": {
					name: "@marianmeres/tempo",
					version: "2.0.1",
					license: "UNLICENSED",
				},
				"node_modules/foo": { version: "1.0.0" },
			},
		},
		null,
		2,
	) + "\n";

	const out = JSON.parse(syncPackageLockVersion(lock, "2.1.0"));
	assertEquals(out.version, "2.1.0");
	assertEquals(out.packages[""].version, "2.1.0");
	// nested dependency versions must not be touched
	assertEquals(out.packages["node_modules/foo"].version, "1.0.0");
	// unrelated fields survive
	assertEquals(out.packages[""].license, "UNLICENSED");
	assertEquals(out.lockfileVersion, 3);
});

Deno.test("syncPackageLockVersion: lockfileVersion 1 (no packages) updates root only", () => {
	const lock = JSON.stringify(
		{ name: "x", version: "1.0.0", lockfileVersion: 1, dependencies: {} },
		null,
		2,
	);
	const out = JSON.parse(syncPackageLockVersion(lock, "1.0.1"));
	assertEquals(out.version, "1.0.1");
	assertEquals(out.packages, undefined);
});

Deno.test("syncPackageLockVersion: no version field returns input unchanged", () => {
	const lock = `{\n  "lockfileVersion": 3,\n  "packages": {}\n}\n`;
	assertEquals(syncPackageLockVersion(lock, "1.0.0"), lock);
});

Deno.test("syncPackageLockVersion: does not invent packages[''].version", () => {
	const lock = JSON.stringify(
		{ version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "x" } } },
		null,
		2,
	);
	const out = JSON.parse(syncPackageLockVersion(lock, "1.1.0"));
	assertEquals(out.version, "1.1.0");
	assertEquals(Object.keys(out.packages[""]), ["name"]);
});

Deno.test("syncPackageLockVersion: throws on unparseable input", () => {
	assertThrows(() => syncPackageLockVersion("{ not json", "1.0.0"));
});

Deno.test("syncPackageLockVersion: preserves tab indentation and trailing newline", () => {
	// tempo's package-lock.json is tab-indented, not npm's default 2 spaces
	const lock = `{\n\t"name": "x",\n\t"version": "1.0.0",\n\t"lockfileVersion": 3\n}\n`;
	const out = syncPackageLockVersion(lock, "1.0.1");
	assertEquals(out.includes('\n\t"name": "x"'), true, "tabs preserved");
	assertEquals(out.includes('\n  "name"'), false, "no space indentation");
	assertEquals(out.endsWith("}\n"), true, "trailing newline preserved");
});

Deno.test("syncPackageLockVersion: no trailing newline stays without one", () => {
	const lock = `{\n  "version": "1.0.0"\n}`;
	const out = syncPackageLockVersion(lock, "1.0.1");
	assertEquals(out.endsWith("}"), true);
	assertEquals(out.endsWith("}\n"), false);
});

Deno.test("syncPackageLockVersion: key order is preserved", () => {
	const lock = JSON.stringify(
		{ name: "x", version: "1.0.0", lockfileVersion: 3, requires: true },
		null,
		2,
	);
	const out = syncPackageLockVersion(lock, "9.9.9");
	assertEquals(Object.keys(JSON.parse(out)), [
		"name",
		"version",
		"lockfileVersion",
		"requires",
	]);
});
