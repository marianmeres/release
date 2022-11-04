# @marianmeres/release

Just a little helper script to automate package version bump fitting my needs.
Basically a wrapper of `npm version`, `git add`, `git commit` and `git tag`.

If specified, `npm version` is executed over multiple sub dirs.

## Single dir

```shell
# Will +1 increase "patch" segment of current version (major.minor.patch).
# Current version is read from ./package.json
npx release

# Will set version and tag to "v1.2.3" regardless of current
npx release -v v1.2.3
```

## Multiple dirs

With multiple dirs, always the cwd `./package.json` is read as the significant one to be
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
