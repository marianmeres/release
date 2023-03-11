#!/usr/bin/env node

const { bold, gray, red, yellow, magenta, cyan, green } = require('kleur/colors');
const prompt = require('prompt');
const path = require('node:path');
const fs = require('node:fs');
const util = require('node:util');
const childProcess = require('node:child_process');
const args = require('minimist')(process.argv.slice(2));

// normalize/init args
const isYes = !!args.yes;
const isHelp = !!args.h || !!args.help;
const DIRS = ['.', ...toUnqArr(args.d), ...toUnqArr(args.dir)];
const VERSION_OLD = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const VERSION_SUFFIX = args.suffix ? `-${args.suffix}` : '';
const GIT_TAG_PREFIX_NONE = !!args['git-tag-prefix-none'];
const GIT_TAG_PREFIX = GIT_TAG_PREFIX_NONE ? '' : args['git-tag-prefix'] || 'v';

const VERSION_NEW = buildVersionString(
	VERSION_OLD,
	`${args.v || ''}`.trim() || 'patch',
	VERSION_SUFFIX
);

const GIT_TAG_NAME = GIT_TAG_PREFIX + VERSION_NEW;

// return early with help?
if (isHelp) return help();

// (auto) message
let MESSAGE = `Release ${GIT_TAG_NAME}`;
if (args.m) MESSAGE = `${args.m} (${MESSAGE})`;

// run now
main().catch(onError);

//////////////////////////////////////////////////////////////////////////////////////////
async function main() {
	if (isYes) {
		await doJob();
	} else {
		prompt.start();
		const property = {
			name: 'yn',
			message: yellow(
				[
					`This will change version from "${VERSION_OLD}" to "${cyan(VERSION_NEW)}"`,
					GIT_TAG_NAME === VERSION_NEW
						? '...'
						: ` (tagged as "${cyan(GIT_TAG_NAME)}")...`,
					DIRS.length > 1
						? gray(`\n(Affected dirs: ${DIRS.map((v) => `"${v}"`).join(' ')})`)
						: '',
					`\nAre you sure? [y/n]`,
				].join('')
			),
			validator: /^[yn]$/i,
			warning: 'You must respond with "y" or "n"',
			default: 'y',
		};
		prompt.get(property, async (err, result) => {
			if (err) return onError(err);
			if (result && result.yn && /y/i.test(result.yn)) {
				await doJob();
			}
		});
	}
}

const debug = (m) => console.log(gray('DEBUG ' + m));

// actual worker
async function doJob() {
	try {
		// "versionize" each dir/package.json
		for (const cwd of DIRS) {
			spawnSync('npm', ['version', VERSION_NEW, '--no-git-tag-version'], {
				cwd,
				stdio: 'ignore',
			});
			spawnSync('git', ['add', 'package.json', 'package-lock.json'], { cwd });
		}

		// now finalize with git stuff, allowing stdout
		spawnSync('git', ['commit', '-m', MESSAGE]);
		spawnSync('git', ['tag', GIT_TAG_NAME]);

		console.log(
			green(
				`\n    ✔ ${VERSION_NEW} ${gray(
					`(you still need to manually push the commit and tag)`
				)}\n`
			)
		);
		process.exit(0);
	} catch (e) {
		onError(e);
	}
}

function spawnSync(...args) {
	const { error } = childProcess.spawnSync(...args);
	if (error) throw error;
}

function onError(e) {
	console.log('\n' + red(e.toString().trim()) + '\n');
	process.exit(1);
}

function help() {
	console.log(`
    ${yellow('Usage:')}
        node release.js [-v major|minor|patch|X.Y.Z] (default: "patch")
                        [-m message]
                        [--yes]
                        [--git-tag-prefix prefix]    (default: "v")
                        [--git-tag-prefix-none]      (will not prefix git tag)
                        [--suffix suffix]
                        [-d|--dir extraDir]

`);
	process.exit();
}

function toUnqArr(v) {
	v ||= [];
	if (!Array.isArray(v)) v = [v];
	return Array.from(new Set(v.filter(Boolean)));
}

function buildVersionString(old, keywordOrVersion, suffix = '') {
	const parts = old.split('.');
	const idxMap = { major: 0, minor: 1, patch: 2 };
	const isKeyword = Object.keys(idxMap).includes(keywordOrVersion);

	let version = keywordOrVersion;

	if (isKeyword) {
		const idx = idxMap[keywordOrVersion];
		const oldSegment = parseInt(parts[idx], 10);
		if (isNaN(oldSegment)) {
			throw new TypeError(
				[
					`Unable to '${keywordOrVersion}' auto increment non-numeric version segment`,
					`(segment '${parts[idx]}' from '${old}').`,
				].join(' ')
			);
		}

		parts[idx] = oldSegment + 1;

		// reset trailing segments to zero
		for (let i = idx + 1; i <= 2; i++) {
			parts[i] = 0;
		}

		version = parts.join('.');
	}

	return version + suffix;
}
