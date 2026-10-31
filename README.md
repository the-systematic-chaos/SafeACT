# SafeACT

SafeACT brings together two hardware-in-the-loop CI systems for [Lingua Franca](https://www.lf-lang.org/) (LF), plus a GitHub App that limits how many Actions jobs each person can use. Each one lives in its own directory and is operated separately:

| Directory | What it does | Hardware |
|-----------|--------------|----------|
| [`physical-ci/`](physical-ci/) | An LF program drives a robot arm that presses numpad keys; each key press is verified | WidowX arm, USB numpad, Raspberry Pi Pico W power relay |
| [`act-lf-testbed/`](act-lf-testbed/) | LF programs are flashed to a robot and its LED, motors, IMU and bump sensor are measured with a camera | Pololu 3pi+ 2040 robot, camera |
| [`actions-job-limiter/`](actions-job-limiter/) | Caps how many Actions jobs each person can have queued or running across the organization, and logs who ran what | None (a Node.js service) |

`physical-ci/` comes from [lf-lang/physical-ci](https://github.com/lf-lang/physical-ci) and `act-lf-testbed/` from [lf-lang/act-lf-testbed](https://github.com/lf-lang/act-lf-testbed). `actions-job-limiter/` was copied in as plain files and has no imported history.

This file covers how to set up and run all three. The full reference for each is in its own README: [physical-ci/README.md](physical-ci/README.md), [act-lf-testbed/README.md](act-lf-testbed/README.md) (with [act-lf-testbed/docs/writing-tests.md](act-lf-testbed/docs/writing-tests.md)) and [actions-job-limiter/README.md](actions-job-limiter/README.md).

---

## Repository layout

```
SafeACT/
├── .github/workflows/   Workflows of both projects (see the table below)
├── .gitmodules          Registers act-lf-testbed/lf-3pi-template
├── physical-ci/         Robot-arm numpad CI
├── act-lf-testbed/      ACT test suite for the Pololu 3pi+
└── actions-job-limiter/ GitHub App: per-person job limit and run log
```

GitHub Actions only reads workflows from the root `.github/workflows/`, so both projects' workflows are kept there under their original names:

| Project | Workflow | Trigger |
|---------|----------|---------|
| physical-ci | `ci.yml` | Manual dispatch |
| physical-ci | `collide.yml` | Manual dispatch |
| physical-ci | `lf-pr.yml` | Reusable (`workflow_call`), called by lingua-franca |
| act-lf-testbed | `act-lf-test-flow.yml` | Pull request into `main` closed; dispatches by label |
| act-lf-testbed | `act-lf-led.yml`, `act-lf-motor.yml`, `act-lf-imu.yml`, `act-lf-bump.yml` | Reusable, one per hardware module |
| act-lf-testbed | `act-lf-cross-workflow.yml`, `act-lf-led_cross.yml` | Reusable, for cross-repository testing |
| act-lf-testbed | `act-lfdev-cross-workflow.yml`, `act-lfdev-led.yml`, `act-lfdev-led_rpi.yml`, `act-lfdev-motor_rpi.yml` | Reusable, tests a lingua-franca dev build |
| act-lf-testbed | `build-image.yml` | None: every trigger is commented out, so the workflow is disabled |

> **Paths not yet updated.** The workflow files are exact copies of the originals, so they still use paths from the original repositories (for example `src/parallel.lf` rather than `physical-ci/src/parallel.lf`, and checkouts of `lf-lang/physical-ci` or `lf-lang/act-lf-testbed`). They need updating before they will run correctly from SafeACT.

### Getting the code

```bash
git clone <SafeACT-repo-url>
cd SafeACT
git submodule update --init --recursive   # fetches act-lf-testbed/lf-3pi-template
```

Unless a section says otherwise, run each project's commands from inside that project's directory (`cd physical-ci` or `cd act-lf-testbed`).

### History

Both projects were imported with `git subtree add` and were not squashed, so all of their original commits are part of this repository's history. Those commits use each project's original root-relative paths, so `git log -- physical-ci/` shows only the import commit. To view one project's history, run `git log <import-commit>^2`, where `<import-commit>` is the "Import physical-ci …" or "Import act-lf-testbed …" commit.

---

## Part 1: physical-ci

A Lingua Franca reactor generates random key sequences. A WidowX arm presses each key on a USB numpad, and the program checks every press against what the numpad reports.

```
GitHub Actions (self-hosted)
    └── Lingua Franca reactor
            ├── InputGenerator  → generates random key sequences
            ├── Robot           → WidowX arm presses the numpad button
            └── NumpadReceiver  → subscribes to numpad_server.py for the actual key press
```

### 1.1 Hardware

| Component | Details |
|-----------|---------|
| WidowX arm (wxai_v0) | `192.168.1.2`, controlled via `trossen_arm` (address can be overridden with `ROBOT_HOST`) |
| USB numpad | `/dev/input/by-id/usb-Usb_KeyBoard_Usb_KeyBoard-event-kbd` |
| Raspberry Pi Pico W | `/dev/ttyACM0`, GPIO20 relay that switches robot power |

### 1.2 One-time setup

**Permissions.** Reading the numpad requires membership in the `input` group, and using the Pico's serial port requires membership in `dialout`. Log out and back in after running:

```bash
sudo usermod -aG input,dialout $USER
```

**Pico firmware:**

```bash
sudo chmod 666 /dev/ttyACM0
mpremote connect /dev/ttyACM0 cp pico/pico.py :main.py
mpremote connect /dev/ttyACM0 reset
```

**Calibration.** Record the hover and press coordinates of each numpad button. The positions are saved to `examples/positions.json`:

```bash
python examples/record_posistions.py
```

(The physical-ci README calls this script `record_positions.py`, but the file in the repository is spelled `record_posistions.py`.)

**Python packages:**

```bash
pip install websockets evdev trossen_arm_sim
```

### 1.3 Start the host services (after every reboot)

CI jobs need three processes running on the robot host. Start each one in its own tmux session so you can check its log. None of them survives a reboot, so start them again before dispatching CI.

| Service | Address | Purpose |
|---------|---------|---------|
| `numpad_server.py` | `127.0.0.1:5100` | Reports key presses from the real numpad |
| `simulation/simulation.py` | `127.0.0.2` | Simulated arm and numpad, with collision detection |
| `pico/power_server.py` | `127.0.0.1:5200` | Switches arm power on and off for jobs |

```bash
tmux new -s numpad                                   # detach with Ctrl-b d; return with: tmux attach -t numpad
python numpad_server.py                              # prints each key as it is pressed

tmux new -s sim
python simulation/simulation.py --host 127.0.0.2     # simulated arm and numpad on the loopback alias

tmux new -s power
python pico/power_server.py                          # switches the arm off, then takes on/off requests from jobs
```

If the numpad is missing or gets unplugged, `numpad_server.py` exits. Plug the numpad back in and start the server again.

Linux routes all of `127.0.0.0/8` to loopback, so the simulation on `127.0.0.2` does not conflict with `numpad_server.py` on `127.0.0.1`.

### 1.4 Run by hand

On the real robot:

```bash
lfc-dev src/parallel.lf && ./bin/parallel
```

Against the simulation (use `127.0.0.2` instead of `127.0.0.1` on the robot host):

```bash
lfc-dev src/parallel.lf
ROBOT_HOST=127.0.0.1 NUMPAD_SERVER_HOST=127.0.0.1 ./bin/parallel
```

Running the simulation on another machine:

```bash
python simulation/simulation.py            # headless, on all interfaces
mjpython simulation/simulation.py --viewer # with the MuJoCo viewer (macOS)
```

A single button press in the MuJoCo scene:

```bash
trossen-arm-sim examples/scene_numpad.xml            # terminal 1
python examples/press_button.py --sim                # terminal 2; omit --sim for the real robot
```

### 1.5 Robot power

Manual control (the power server does not notice these changes, so switch the arm off again afterwards):

```bash
python pico/serial_control.py on                      # power on
python pico/serial_control.py off                     # power off
python pico/serial_control.py on --mode normally_on   # normally-on relay mode
```

During CI, `pico/power_server.py` provides `POST /on`, `POST /off` and `GET /` (state). The `execute` job does the following in order:
1. Switches the arm on (`pico/power_client.py on`).
2. Waits up to two minutes for the controller to boot (`pico/wait_for_arm.py`).
3. Runs the program.
4. Parks the arm and switches it off. This step runs even if the program fails.

Power-on is a lease. If a job does not renew or end it, the server switches the arm off after 8 minutes, so a job that dies cannot leave the arm on. The server also switches the arm off when it starts and when it exits. `ROBOT_POWER_URL` is set only for the `lf-thor-widowx` runner, so the power steps do nothing on `lf-thor-sim`.

### 1.6 Run CI

Each workflow first builds `lfc` and then runs two stages:

1. **`simulate`** runs on the `lf-thor-sim` runner against `simulation/simulation.py`. The job fails if the arm touches anything other than a key, or presses a key harder than 10 N (`--max-press-force`).
2. **`execute`** runs on the `lf-thor-widowx` runner, on the real arm, and only after `simulate` passes. It passes when every key press is verified by `numpad_server.py`.

| Workflow | How to run | Expected result |
|----------|------------|-----------------|
| `ci.yml` | Dispatch manually from the Actions tab, then approve in the `physical-ci` environment | Both stages pass with `src/parallel.lf` |
| `collide.yml` | Dispatch manually and approve | `simulate` **fails** (`src/collide.lf` drives the gripper into the floor) and `execute` is skipped. If `simulate` misses the collision, `execute` runs the same program on the real arm |
| `lf-pr.yml` | Called by lingua-franca's `physical-ci.yml` when a pull request is labeled `physical-ci` | Results appear as checks on the lingua-franca pull request |

Every job that runs the program has a 5-minute timeout and ends with `examples/home.py` (`if: always()`). That step stops any leftover program, clears controller errors, parks the arm, and resets the simulation after a collision.

**Requirements for testing lingua-franca pull requests:**
- The repository hosting `lf-pr.yml` must be public.
- Both lingua-franca and the hosting repository must have a `physical-ci` environment. Its required reviewer must be the approvers team, so every run is approved before code from a pull request is built.
- lingua-franca must require approval to run workflows from all external contributors.
- lingua-franca must have a `physical-ci` label.

The physical-ci README also describes a `test.yml` workflow for ARC, but no such file is in the repository.

### 1.7 Runners (ARC on k3s)

The runners are [Actions Runner Controller](https://github.com/actions/actions-runner-controller) scale sets running in Kubernetes mode on **k3s**. Do not use minikube: its Docker driver hides the host network, and the job pods need `hostNetwork: true` to reach the arm at `192.168.1.2` and the services on loopback.

Two scale sets are installed from the same `arc-config.yaml`. They differ only in the job template they mount from `arc-job-templates.yaml`:
- `lf-thor-widowx` uses `job-template` and drives the real robot.
- `lf-thor-sim` uses `job-template-sim` and drives the simulation.

Install:

```bash
helm install arc --namespace arc-controller --create-namespace \
    oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller

kubectl create namespace arc-runners
kubectl apply -f arc-job-templates.yaml

kubectl create secret generic lf-arc-github-app -n arc-runners \
    --from-literal=github_app_id=<app-id> \
    --from-literal=github_app_installation_id=<installation-id> \
    --from-file=github_app_private_key=<app-private-key>.pem   # *.pem is gitignored

helm install lf-thor-widowx --namespace arc-runners --set maxRunners=1 -f arc-config.yaml \
    oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
helm install lf-thor-sim --namespace arc-runners --set maxRunners=1 \
    --set 'template.spec.volumes[0].configMap.name=job-template-sim' -f arc-config.yaml \
    oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

To apply configuration changes, run `kubectl apply -f arc-job-templates.yaml`, then `helm upgrade` each scale set with the same flags used to install it. A runner set that was installed without Kubernetes mode must be removed with `helm uninstall` and installed again; `helm upgrade` cannot switch it.

Status and logs:

```bash
kubectl get pods -n arc-controller
kubectl get pods -n arc-runners        # one <runner-pod>-workflow pod per running job
kubectl logs -n arc-controller -l app.kubernetes.io/name=gha-runner-scale-set-controller
kubectl logs -n arc-runners -l actions.github.com/scale-set-name=lf-thor-widowx
kubectl logs -f -n arc-runners <pod-name>
```

Shutdown:

```bash
helm uninstall lf-thor-widowx --namespace arc-runners
helm uninstall lf-thor-sim --namespace arc-runners
helm uninstall arc --namespace arc-controller
```

### 1.8 Job image

Jobs run in the image named by the workflow's `container.image` key (currently `depetrol/physical-ci:latest`). The image does not include `lfc`; each workflow installs the `lfc` it built. The image does need:
- `bash`
- Java 17 or newer
- A C toolchain with CMake and the Python headers
- The program's Python packages

The robot host is arm64, so build the image for both architectures:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t depetrol/physical-ci --push .
```

---

## Part 2: act-lf-testbed (ACT)

Automated CPS Testing (ACT) compiles LF programs and flashes them to a [Pololu 3pi+ 2040 robot](https://www.pololu.com/docs/0J86). A camera watches the robot, and the test checks the measured behavior against expected ranges. Test data (CSVs and graphs) is uploaded as workflow artifacts.

Hardware modules that can be tested:
1. On-board LED (blink timing)
2. Motors (RPM)
3. IMU with display (tilt)
4. Bump sensor with display

### 2.1 Directory roles

| Path | Role |
|------|------|
| `act-lf-testbed/lf-3pi-template/` | Git submodule ([lf-lang/lf-3pi-template](https://github.com/lf-lang/lf-3pi-template)). The LF project (pico-sdk, robot-lib, `shell.nix`) that is compiled and flashed. Test files are copied into it before every run |
| `act-lf-testbed/test_lf_programs/` | The `.lf` programs under test, the Python scripts that build, measure and plot each module, and `cleanup.sh` |
| `act-lf-testbed/docker/Dockerfile.act-lf-dev` | Image with `lfc`, the ARM toolchain and `picotool`, used by the `act-lfdev-*` workflows |
| `act-lf-testbed/env_setup.py` | One-time setup script for a runner host |

### 2.2 One-time runner setup

The jobs run on a self-hosted runner with the labels `[self-hosted, linux, lf-act-ast]`. Hardware and operating system installation is done by hand, outside CI.

1. Connect the Pololu 3pi+ 2040 and the camera to the runner host.
2. Run the setup script by hand. Several steps need interactive `sudo` or a reboot, which is why it is not part of CI:

   ```bash
   cd act-lf-testbed
   python3 env_setup.py
   ```

   The script:
   - Installs `gh`, `git`, `curl`, `openjdk-17-jdk`, `nix`, `screen` and `cmake`.
   - Installs the LF toolchain from `install.lf-lang.org`.
   - Adds the user to the `nix-users` group.
   - Enables `experimental-features = nix-command flakes`.

   Reboot if the script asks you to.
3. Register the host as a self-hosted GitHub Actions runner with the `lf-act-ast` label. It will then wait for jobs.

### 2.3 What a test run does

Each per-module workflow (for example `act-lf-led.yml`) runs this chain of jobs:

```
setup            checkout with submodules; `nix develop --command true` to prime the shell
pythonpackages   Python venv with opencv/numpy/pandas/...
filecleanup      copy test_lf_programs/cleanup.sh into lf-3pi-template/ and run it
filesetup        copy the module's *.py and *.lf files into lf-3pi-template/(src)
compile<N>       nix develop --command lfc src/<Program_N>.lf
flash<N>         nix develop --command picotool load -x bin/<Program_N>.elf -f
run<N>           python3 test_<module>_module.py <N>; asserts the measured value is in range
  ...            repeated for each variant N = 1, 2, 3; one robot, so the variants run one after another
plotgraph        python3 plot_<module>.py
<module>upload   upload the CSV/SVG as an artifact
```

### 2.4 Trigger tests with labels

A pull request selects which tests to run through its labels. Each label must already exist in the repository **and** be attached to the pull request.

| Label | Runs |
|-------|------|
| `act-lf-led` | LED blink-timing test (`act-lf-led.yml`, `act-lf-led_cross.yml`, `act-lfdev-led.yml`) |
| `act-lf-motor` | Motor RPM test (`act-lf-motor.yml`) |
| `act-lf-imu` | IMU/tilt display test (`act-lf-imu.yml`) |
| `act-lf-bump` | Bump sensor/display test (`act-lf-bump.yml`) |

**In-repo:**
1. Add the labels to a pull request against `main`.
2. Merge or close the pull request. `act-lf-test-flow.yml` runs on `pull_request: closed` and calls the per-module workflows in order: LED → motor → IMU → bump.

**From another repository** (for example lingua-franca or a board template), call a reusable workflow:

```yaml
on:
  pull_request:
    types: [opened]
jobs:
  led-test:
    if: contains(github.event.pull_request.labels.*.name, 'act-lf-led')
    uses: <owner>/<repo>/.github/workflows/<test-workflow>.yml@main
    secrets: inherit
```

The original documentation points this at `lf-lang/act-lf-testbed`. To use the copies in SafeACT, point it at this repository instead. `@main` can be replaced with another branch to test a different version of the suite.

### 2.5 The dev image

The `act-lfdev-*` workflows run `lfc` and the analysis scripts inside the `act-lf:act-lf-test-docker` image. `build-image.yml` builds that image for `linux/arm64` from `docker/Dockerfile.act-lf-dev` and publishes it as the `docker-image` artifact. It only builds on `main`.

In SafeACT, every trigger in `build-image.yml` (`workflow_call`, the daily `schedule` and `workflow_dispatch`) is commented out, so the workflow does not run and no fresh `docker-image` artifact is produced. To build the image, uncomment the trigger you need, or build it locally from `act-lf-testbed/`:

```bash
docker buildx build --platform linux/arm64 -f docker/Dockerfile.act-lf-dev \
    -t act-lf:act-lf-test-docker --load .
```

Using the image locally:

```bash
docker run --rm -v "$PWD:/work" act-lf:act-lf-test-docker lfc src/Blink.lf
docker run --rm -it -v "$PWD:/work" act-lf:act-lf-test-docker        # shell
```

The build arguments `LF_REPO`/`LF_REF` choose which Lingua Franca to build (default: `master`). `TEMPLATE_REPO`/`TEMPLATE_REF` choose which lab repository's pinned Pico SDK the image's build-time RP2040 smoke test uses.

### 2.6 Adding tests

See [act-lf-testbed/docs/writing-tests.md](act-lf-testbed/docs/writing-tests.md). In short:
1. Put the `.lf` program and its `test_/plot_/analyze_` scripts in `test_lf_programs/`.
2. Copy an existing per-module workflow and adapt it.
3. Add an `act-lf-<module>` label and wire it into `act-lf-test-flow.yml`.

---

## Part 3: actions-job-limiter

A small GitHub App with no dependencies (Node.js 20.6 or later). It caps how many GitHub Actions jobs each person can have queued or running at once across the organization, and keeps a log of who ran what, from which repo and branch, and when.

Both hardware systems expose reusable workflows that other repositories call from pull requests, and each runs on a single robot. The limiter can be pointed at those workflows so that no one person fills the queue. It is not wired into any SafeACT workflow; it runs as a separate service.

### 3.1 How it works

- **Jobs are charged to whoever triggered the run:** the person who pushed, opened the pull request, dispatched the workflow, or clicked re-run. The count spans every repository in the organization.
- **Only some workflows are watched.** If `TARGET_WORKFLOWS` is set, only runs that are, or call, one of those workflows are counted, limited and logged. The match works at any branch, tag or SHA, so callers can't avoid it by pinning.
- **Whole runs are cancelled.** GitHub cannot cancel single jobs. When the limiter cancels a run, it posts a **Job limit** check on the commit explaining why.
- **Two modes:**
  - `MODE=soft` (the default) checks each run once, when its first job is queued, and never cancels work in progress.
  - `MODE=hard` checks every job, so no one can exceed the limit.
- **Environment approvals:** jobs waiting on an environment approval don't count until they start. This matters for physical-ci, whose jobs wait in the `physical-ci` environment.

A reusable workflow runs as part of the *calling* repository's run. So the app must be installed on the repositories that call the workflow, not only on the repository that hosts it.

### 3.2 Set up

1. **Create the GitHub App** under the organization's **Settings → Developer settings → GitHub Apps → New GitHub App**:
   - **Webhook URL:** where the limiter will run, ending in `/webhook`. **Webhook secret:** a long random string.
   - **Repository permissions:** Actions: *Read and write*. Checks: *Read and write* (optional, used for the explanation check).
   - **Subscribe to events:** *Workflow job* and *Workflow run*.
   - **Where can this GitHub App be installed:** *Only on this account*.
2. **Generate a private key** on the app's settings page and note the App ID.
3. **Install the app** on the organization, with access to all repositories or at least every repository that calls the watched workflows.
4. **Configure and start it** somewhere GitHub can reach:

   ```bash
   cd actions-job-limiter
   cp .env.example .env   # set the app ID, key path, webhook secret, TARGET_WORKFLOWS and ADMIN_TOKEN
   npm start              # or, with the variables already set: node src/index.js
   ```

   To try it from a laptop, forward webhook deliveries through a tunnel such as [smee.io](https://smee.io).

For example, to watch the SafeACT workflows that other repositories call:

```bash
TARGET_WORKFLOWS=<owner>/SafeACT/.github/workflows/lf-pr.yml,<owner>/SafeACT/.github/workflows/act-lf*-cross-workflow.yml
```

`*` matches within a single path segment. Leave `TARGET_WORKFLOWS` unset to watch every workflow.

### 3.3 Roll out in dry run

The app starts with `DRY_RUN=true`. It counts and logs everything and records each run it *would* cancel as `would_cancel`, but cancels nothing.
1. Leave it running for a few days.
2. Check `GET /runs?decision=would_cancel`.
3. Adjust `MAX_JOBS_PER_USER` (default `5`) and `USER_LIMITS` (for example `release-captain=20,renovate[bot]=3`).
4. Set `DRY_RUN=false`.

### 3.4 Read the run log

Every watched run is appended to `RUN_LOG_FILE` (default `runs.jsonl`; `.env.example` uses `./data/runs.jsonl`). Set `ADMIN_TOKEN` (at least 16 characters, e.g. `openssl rand -hex 32`) to turn on the read endpoints:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<limiter-host>/runs                          # newest 1000 runs
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://<limiter-host>/runs?user=<login>&since=2026-10-01&format=csv" -o runs.csv
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://<limiter-host>/runs?decision=cancelled"
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<limiter-host>/active                        # who is using job slots now
```

`/runs` filters: `user`, `repo`, `branch`, `decision`, `since`, `until`, `limit` (default 1000, up to 100000) and `format=json|csv`. `GET /healthz` is a health check.

You can also read the log on the server without the endpoints:

```bash
npm run report -- --user <login> --since 2026-10-01
npm run report -- --repo <owner>/<repo> --format csv > runs.csv
```

Rotate the log with logrotate's `copytruncate`. The log contains usernames, branch names and pull request titles. Keep it and `ADMIN_TOKEN` private, and serve the app over HTTPS.

### 3.5 Operating notes

- **Run exactly one instance.** Counts are kept in memory. A restart forgets them, which fails open: people get extra room until their current jobs finish. The run log survives restarts.
- **Missed webhooks are caught up.** Every `SWEEP_INTERVAL_SECONDS` (300), the app asks GitHub about any job or run it hasn't heard about for `STALE_AFTER_SECONDS` (900). Failed deliveries can also be redelivered from the app's **Advanced** settings.
- **Exemptions:**
  - Bots are exempt by default (`EXEMPT_BOTS=true`).
  - Scheduled runs are exempt by default (`EXEMPT_EVENTS=schedule`).
  - `EXEMPT_ACTORS` lists people who are never limited.
  - Exempt runs are still logged.
- **When in doubt, the run goes ahead.** If the app can't tell who started a run, or GitHub refuses the cancel, the run is let through and the reason is logged.
- **Guard the private key.** With Actions write access, the app can cancel any run in any repository it is installed on.
- **Tests:** run `npm test` from `actions-job-limiter/`.

The full list of environment variables is in [actions-job-limiter/README.md](actions-job-limiter/README.md#configuration).

---

## Quick comparison of the hardware systems

| | physical-ci | act-lf-testbed |
|---|---|---|
| Device under test | WidowX arm and USB numpad | Pololu 3pi+ 2040 |
| Runners | ARC on k3s: `lf-thor-sim`, `lf-thor-widowx` | Self-hosted: `[self-hosted, linux, lf-act-ast]` |
| How tests start | Manual dispatch, or the `physical-ci` label on lingua-franca | `act-lf-<module>` labels on pull requests |
| Safety gates | Simulation collision check before the real arm runs, environment approval, power lease | Measured values checked against expected ranges |
| Host prerequisites | Three host services, Pico firmware, calibration | `env_setup.py`, Nix, LF toolchain |
| Results | Job pass/fail, checks on the lingua-franca pull request | Uploaded CSV/SVG artifacts |
