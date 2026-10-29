# pstack for T3 Code

T3 Code bundles the [native pstack-t3code port](https://github.com/ScriptedAlchemy/pstack-t3code)
of Lauren Tan's pstack, under the [MIT license](upstream/LICENSE). `upstream/` is an unmodified
snapshot of that repository's `plugins/pstack/`, including `automate-maintainer` and `automate-team`.
The skills use T3 Code tools directly; no harness adapter is needed.

From the repository root, with a clean pstack-t3code checkout:

```sh
vp run pstack:sync /path/to/pstack-t3code
vp test run packages/pstack
```

Only the sync command writes `upstream/` and `UPSTREAM.json`. It copies tracked pack files,
records the source repository, commit, subtree hash, version, file hashes and executable flags,
then validates native content, skill names, and role defaults. Ignored helper dependencies stay
out of the snapshot. The port's `UPDATING.md` describes how to bring changes from the original
pstack into the native source before syncing it here.
