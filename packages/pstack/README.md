# pstack for T3 Code

Bundled pstack by Lauren Tan, copyright 2026, under the [MIT license](upstream/LICENSE).
`upstream/` is an unmodified snapshot; `t3-code.md` is the T3 Code harness adapter.

From the repository root:

```sh
vp run pstack:sync /path/to/cursor/plugins
vp test run packages/pstack
```

Only the sync command writes `upstream/` and `UPSTREAM.json`. It replaces the snapshot,
records its commit, subtree hash, version, file hashes and executable flags, then reports
every adapter or pack check that needs attention.
