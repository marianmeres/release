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
let VERSION_NEW = `${args.v || ''}`.trim() || '1';
const VERSION_OLD = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

// return early with help?
if (isHelp) return help();

// auto increment version (if +1)
if (/^\+?1$/.test(VERSION_NEW)) {
	VERSION_NEW =
		'v' +
		VERSION_OLD.split('.')
			.map((v, idx) => {
				if (idx === 2) v = parseInt(v) + 1;
				return v;
			})
			.join('.');
}

// (auto) message
let MESSAGE = `Release ${VERSION_NEW}`;
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
					`This will change version from "${VERSION_OLD}" to "${cyan(VERSION_NEW)}"...`,
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
			spawnSync('npm', ['version', VERSION_NEW, '--no-git-tag-version'], { cwd, stdio: 'ignore' });
			spawnSync('git', ['add', 'package.json', 'package-lock.json'], { cwd });
		}

		// now finalize with git stuff, allowing stdout
		spawnSync('git', ['commit', '-m', MESSAGE]);
		spawnSync('git', ['tag', VERSION_NEW]);

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
        node release.js
        node release.js [-v +1|vX.Y.Z] [-m message] [--yes] [-d|--dir extraDir]

`);
	process.exit();
}

function toUnqArr(v) {
	v ||= [];
	if (!Array.isArray(v)) v = [v];
	return Array.from(new Set(v.filter(Boolean)));
}
