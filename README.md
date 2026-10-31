# SafeACT

SafeACT combines two projects. Each one keeps its own top-level directory and its full git history:

| Directory | Origin | Description |
|-----------|--------|-------------|
| [`physical-ci/`](physical-ci/) | [lf-lang/physical-ci](https://github.com/lf-lang/physical-ci) | Physical CI: a robot arm presses hardware buttons, with simulation and Pico power control |
| [`act-lf-testbed/`](act-lf-testbed/) | [lf-lang/act-lf-testbed](https://github.com/lf-lang/act-lf-testbed) | ACT-based Lingua Franca hardware testbed (LED, motor, IMU, and bump tests) |

See the README inside each directory for project-specific documentation.

## Layout notes

- Both projects were imported with `git subtree add` (not squashed), so all original commits are part of this repository's history. Those commits use each project's original root-relative paths. To view one project's history, run `git log <import-commit>^2`, where `<import-commit>` is the "Import physical-ci …" or "Import act-lf-testbed …" commit.
- `act-lf-testbed/lf-3pi-template` is a git submodule. It is registered in the root `.gitmodules`. Run `git submodule update --init` after cloning.
- Each project's original workflows are kept under `<project>/.github/workflows/`. GitHub Actions only runs workflows in the repository-root `.github/workflows/`, so those files will not run from their current location.
