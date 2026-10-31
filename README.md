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
- Both projects' workflows were moved unchanged into the root [`.github/workflows/`](.github/workflows/), because GitHub Actions only runs workflows from there and does not allow subdirectories. No filenames clashed, so every file kept its original name. They belong to these projects:

  | Project | Workflows |
  |---------|-----------|
  | physical-ci | `ci.yml`, `collide.yml`, `lf-pr.yml` |
  | act-lf-testbed | `act-lf-*.yml`, `act-lfdev-*.yml`, `build-image.yml` |

  The workflows still use the paths from their original repositories. For example, they refer to `src/parallel.lf` rather than `physical-ci/src/parallel.lf`. Their paths must be updated to the project subdirectories before they will work in this repository.
