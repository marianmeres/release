# @marianmeres/release

Just a little helper script to automate package version bump fitting my needs.
Basically a wrapper of `npm version`, `git add`, `git commit` and `git tag`.

If specified, `npm version` is executed over multiple sub dirs.

The script will prompt you for confirmation, unless called with `--yes` arg.

## The workflow
1. do work
2. commit
3. call `npx release [-v major|minor|patch|x.y.z]` (default is `patch`)
4. confirm version change
5. `git push` && `git push origin vX.Y.Z` manually

## Todo

- Automate point 5. from the above as well (after prompt confirmation)

## Install and execute

```shell
# install
npm i -D @marianmeres/release

# and execute as node script directly
node ./node_modules/@marianmeres/release/release.js

# or as npm executable, via npx
npx @marianmeres/release
# or, if already installed, just
npx release

# to execute as package.json script, add to your package.json:
# ...
#  "scripts": {
#   ...
    "release": "release" # add args as needed
#  }
# ...
# and then run
npm run release
```

## Single dir mode

```shell
# Will +1 increase "patch" segment of current version (major.minor.patch).
# Current version is read from ./package.json
npx release

# Will set version and tag to "v1.2.3" regardless of current
npx release -v v1.2.3
```

## Multiple dirs mode

With multiple dirs, always the `{cwd}/package.json` is read as the significant one to be
bumped. All other dirs (specified via `-d`) are then synced accordingly.

```
.
├── .git
├── package.json
├── sub1
│   └── package.json
└── sub2
    └── package.json
```

```shell
npx release -d sub1 -d sub2
```
