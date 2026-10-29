import assert from "node:assert/strict";
import { test } from "node:test";
import { bumpVersion, syncPackageLockVersion } from "../src/release.ts";

test("bumpVersion", () => {
	assert.deepEqual(bumpVersion("1.2.3", "patch"), "1.2.4");
	assert.deepEqual(bumpVersion("1.2.3", "minor"), "1.3.0");
	assert.deepEqual(bumpVersion("1.2.3", "major"), "2.0.0");
	assert.deepEqual(bumpVersion("0.0.0", "patch"), "0.0.1");
	assert.throws(() => bumpVersion("not-semver", "patch"));
	assert.throws(() => bumpVersion("1.2", "patch"));
	assert.throws(() => bumpVersion("1.2.3+build", "patch"));
});

test("bumpVersion: a prerelease promotes to the release it precedes", () => {
	// matches `npm version` / semver.inc — without this, releasing an explicit
	// prerelease would leave the manifest in a state no keyword bump could move
	assert.deepEqual(bumpVersion("1.2.3-rc.1", "patch"), "1.2.3");
	assert.deepEqual(bumpVersion("1.2.3-rc.1", "minor"), "1.3.0");
	assert.deepEqual(bumpVersion("1.2.3-rc.1", "major"), "2.0.0");
	// already at a .0 boundary -> the prerelease is simply dropped
	assert.deepEqual(bumpVersion("1.2.0-rc.1", "minor"), "1.2.0");
	assert.deepEqual(bumpVersion("1.0.0-rc.1", "major"), "1.0.0");
	assert.deepEqual(bumpVersion("1.0.0-rc.1", "patch"), "1.0.0");
});

test("syncPackageLockVersion: lockfileVersion 3 updates both fields", () => {
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
	assert.deepEqual(out.version, "2.1.0");
	assert.deepEqual(out.packages[""].version, "2.1.0");
	// nested dependency versions must not be touched
	assert.deepEqual(out.packages["node_modules/foo"].version, "1.0.0");
	// unrelated fields survive
	assert.deepEqual(out.packages[""].license, "UNLICENSED");
	assert.deepEqual(out.lockfileVersion, 3);
});

test("syncPackageLockVersion: lockfileVersion 1 (no packages) updates root only", () => {
	const lock = JSON.stringify(
		{ name: "x", version: "1.0.0", lockfileVersion: 1, dependencies: {} },
		null,
		2,
	);
	const out = JSON.parse(syncPackageLockVersion(lock, "1.0.1"));
	assert.deepEqual(out.version, "1.0.1");
	assert.deepEqual(out.packages, undefined);
});

test("syncPackageLockVersion: no version field returns input unchanged", () => {
	const lock = `{\n  "lockfileVersion": 3,\n  "packages": {}\n}\n`;
	assert.deepEqual(syncPackageLockVersion(lock, "1.0.0"), lock);
});

test("syncPackageLockVersion: does not invent packages[''].version", () => {
	const lock = JSON.stringify(
		{ version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "x" } } },
		null,
		2,
	);
	const out = JSON.parse(syncPackageLockVersion(lock, "1.1.0"));
	assert.deepEqual(out.version, "1.1.0");
	assert.deepEqual(Object.keys(out.packages[""]), ["name"]);
});

test("syncPackageLockVersion: throws on unparseable input", () => {
	assert.throws(() => syncPackageLockVersion("{ not json", "1.0.0"));
});

test("syncPackageLockVersion: preserves tab indentation and trailing newline", () => {
	// tempo's package-lock.json is tab-indented, not npm's default 2 spaces
	const lock = `{\n\t"name": "x",\n\t"version": "1.0.0",\n\t"lockfileVersion": 3\n}\n`;
	const out = syncPackageLockVersion(lock, "1.0.1");
	assert.deepEqual(out.includes('\n\t"name": "x"'), true, "tabs preserved");
	assert.deepEqual(out.includes('\n  "name"'), false, "no space indentation");
	assert.deepEqual(out.endsWith("}\n"), true, "trailing newline preserved");
});

test("syncPackageLockVersion: no trailing newline stays without one", () => {
	const lock = `{\n  "version": "1.0.0"\n}`;
	const out = syncPackageLockVersion(lock, "1.0.1");
	assert.deepEqual(out.endsWith("}"), true);
	assert.deepEqual(out.endsWith("}\n"), false);
});

test("syncPackageLockVersion: key order is preserved", () => {
	const lock = JSON.stringify(
		{ name: "x", version: "1.0.0", lockfileVersion: 3, requires: true },
		null,
		2,
	);
	const out = syncPackageLockVersion(lock, "9.9.9");
	assert.deepEqual(Object.keys(JSON.parse(out)), [
		"name",
		"version",
		"lockfileVersion",
		"requires",
	]);
});
