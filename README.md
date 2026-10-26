# Physical CI

Hardware-in-the-loop CI system that uses a robotic arm to physically press numpad buttons and verify the inputs, built with [Lingua Franca](https://www.lf-lang.org/) reactive programming.

## Architecture

```
GitHub Actions (self-hosted)
    └── Lingua Franca reactor
            ├── InputGenerator  → generates random key sequences
            ├── Robot           → WidowX arm presses the numpad button
            └── NumpadReceiver  → subscribes to numpad_server.py for the actual key press
```

The system compiles LF source (`src/*.lf`) to C extensions + Python wrappers, then executes the reactive test loop: generate key → press button → verify input → repeat.

## Hardware


| Component            | Details                                                    |
| -------------------- | ---------------------------------------------------------- |
| WidowX arm (wxai_v0) | `192.168.1.2`, controlled via `trossen_arm`                |
| USB numpad           | `/dev/input/by-id/usb-Usb_KeyBoard_Usb_KeyBoard-event-kbd` |
| Raspberry Pi Pico W  | `/dev/ttyACM0`, GPIO20 relay for robot power control       |




## Setup



### Pico firmware

```bash
sudo chmod 666 /dev/ttyACM0
mpremote connect /dev/ttyACM0 cp pico/pico.py :main.py
mpremote connect /dev/ttyACM0 reset
```



### Calibration

Record numpad button positions (hover + press coordinates) for the arm:

```bash
python examples/record_positions.py   # saves to examples/positions.json
```



### Robot power control

```bash
python pico/serial_control.py on              # power on the robot
python pico/serial_control.py off             # power off
python pico/serial_control.py on --mode normally_on  # use normally-on relay mode
```



### Host services

Three processes run by hand on the robot host, each in its own tmux session so its log is at hand: `numpad_server.py` (real numpad, `127.0.0.1:5100`), `simulation/simulation.py` (simulated arm and numpad, `127.0.0.2`) and `pico/power_server.py` (arm power, `127.0.0.1:5200`, see Arm power under CI/CD). CI jobs expect all three. None survives a reboot; start them again before dispatching CI.

Reading the numpad needs membership in the `input` group, the Pico's serial port membership in `dialout` (`sudo usermod -aG input,dialout $USER`, then log in again). The numpad server exits if the numpad is missing or unplugged; rerun it after plugging the numpad in.

```bash
pip install websockets evdev trossen_arm_sim

tmux new -s numpad                                   # detach with Ctrl-b d, return with: tmux attach -t numpad
python numpad_server.py                              # prints each key as it is pressed

tmux new -s sim
python simulation/simulation.py --host 127.0.0.2     # simulated arm and numpad on the loopback alias

tmux new -s power
python pico/power_server.py                          # switches the arm off, then takes on/off requests from jobs
```



### Build & run

```bash
lfc-dev src/parallel.lf && ./bin/parallel
```



## Simulation

[trossen_arm_sim](https://github.com/depetrol/trossen_arm_sim) replaces the arm controller with a MuJoCo simulation that the unmodified `trossen_arm` driver connects to; see its README for usage, scenes and the collision stream. Here it is used with `examples/scene_numpad.xml`, which places the numpad to match `examples/positions.json`, and the program is pointed at it by setting `ROBOT_HOST` to `127.0.0.1`.

```bash
pip install trossen_arm_sim
trossen-arm-sim examples/scene_numpad.xml            # terminal 1
python examples/press_button.py --sim                # terminal 2; omit --sim for the real robot
```

On the robot host the full simulation (`simulation/simulation.py`, see CI/CD) runs in a tmux session bound to `127.0.0.2` (see Host services): Linux routes all of 127.0.0.0/8 to loopback, so the simulated arm and numpad do not collide with `numpad_server.py`, which listens on `127.0.0.1`. The `lf-thor-sim` runner's jobs reach the simulation there.



## CI/CD

`ci.yml` — Manual-dispatch pipeline that compiles `src/parallel.lf` and runs the binary in two stages, as two jobs with identical steps. A `build-lfc` job first builds `lfc` from lingua-franca's default branch and uploads it as the `lfc` artifact; the two stages install it into the job image. `build-lfc` uses physical-ci's `physical-ci` environment, so each run waits for approval like a run of `lf-pr.yml` (see Testing lingua-franca pull requests). The program only knows the arm at `ROBOT_HOST` and the numpad server at `NUMPAD_SERVER_HOST`, set per runner in its job template (`arc-job-templates.yaml`); whether those are real or simulated is decided outside the container.

1. `simulate` — runs against `simulation/simulation.py`, which serves the simulated arm, a simulated numpad server that reports a key whenever the simulated gripper touches it, and collision detection: if the arm touches anything but a key, or presses a key harder than 10 N (`--max-press-force`), the simulated controller faults. The driver in the program then raises, the program exits non-zero and the job fails, exactly as a hardware fault would. The reason is in the simulator's log.
2. `execute` (only after stage 1 passes) — passes if the program exits cleanly, i.e. every key the robot pressed was verified through the numpad server. It runs on the `lf-thor-widowx` runner, which drives the real arm and verifies through `numpad_server.py` on that host.

Every job that runs the program has `timeout-minutes: 5` and ends with a step that runs `examples/home.py` whatever happened to the program (`if: always()`): it ends a program left over from a cancelled step, clears any controller error and parks the arm with the gripper closed. The program's own shutdown reaction does the same on a clean stop, but not when a reaction fails, which exits the runtime without shutdown reactions, nor when the job is cancelled or times out. The step also resets the simulation after a collision fault, so the next run starts clean.

`simulate` runs on the `lf-thor-sim` runner, on the same host as `lf-thor-widowx`; its jobs reach the simulation at `127.0.0.2`, where the tmux session from Host services serves it. To run the simulation by hand elsewhere:

```bash
python simulation/simulation.py            # headless, on all interfaces
mjpython simulation/simulation.py --viewer # with the MuJoCo viewer (macOS)
```

To run the program locally against it (`127.0.0.2` on the robot host):

```bash
lfc-dev src/parallel.lf
ROBOT_HOST=127.0.0.1 NUMPAD_SERVER_HOST=127.0.0.1 ./bin/parallel
```

`collide.yml` — Manual-dispatch check of the collision detection itself. It has the same jobs as `ci.yml`, including the approval, but runs `src/collide.lf`, which drives the gripper into the floor. The expected result is a failed `simulate` job, because the simulation faults the controller on the collision, and a skipped `execute` job. If the simulation misses the collision, `execute` runs `src/collide.lf` on the real arm.

`lf-pr.yml` — Reusable workflow that tests a lingua-franca pull request on this hardware. lingua-franca's `physical-ci.yml` calls it when a pull request is labeled `physical-ci`, and again on each new commit while the label is present. It runs in lingua-franca's context: `build-lfc` checks out the pull request's merge commit, builds `lfc` with `./gradlew :cli:lfc:installDist`, and uploads it as the `lfc` artifact. `simulate` and `execute` install that `lfc` into the job image and run the same steps as `ci.yml`, so results appear as checks on the pull request.

### Testing lingua-franca pull requests

These settings make the cross-repository call possible and gate runs from pull requests:

- **physical-ci is public.** A public repository such as lingua-franca can only call reusable workflows from public repositories.
- **lingua-franca and physical-ci each have a `physical-ci` environment whose required reviewer is the [`physical-ci-approvers`](https://github.com/orgs/lf-lang/teams/physical-ci-approvers) team.** `build-lfc` uses the environment, so a team member approves every run of `lf-pr.yml` before code from the pull request is built or run. `ci.yml` and `collide.yml` use physical-ci's environment in the same way. To let someone else approve runs, add them to the team. Create both before `physical-ci.yml` lands: GitHub creates a missing environment without protection.
- **lingua-franca requires approval to run workflows from all external contributors.** The runners are in the organization's Default group, which every lf-lang repository can use, so a pull request from a fork could add its own job with `runs-on: lf-thor-widowx`. This approval setting is what stops such a job from running unreviewed.
- **lingua-franca has a `physical-ci` label.**

`test.yml` — Manual-dispatch workflow for [Actions Runner Controller](https://github.com/actions/actions-runner-controller) (Kubernetes-based runners).

### Job image

Every job names its image in the workflow's `container:` key. The runners use ARC's kubernetes mode: the runner pod runs only the GitHub runner, and for each job it starts a separate pod from that image. The runner's job template (`arc-job-templates.yaml`) adds host networking and the `ROBOT_HOST` and `NUMPAD_SERVER_HOST` env to that pod; it cannot change the image.

To use another image, change `container.image` in the workflow. The image does not contain `lfc`: each workflow installs the `lfc` it tests into the job (`lf-pr.yml` downloads the one its `build-lfc` job built). The image needs what that `lfc` and the program need: `bash`, Java 17 or newer, a C toolchain with CMake and the Python headers for the Python target, and the program's Python packages. The cluster pulls it from the registry. The robot host is arm64, so build the image for arm64 as well as amd64:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t depetrol/physical-ci --push .
```



### ARC setup (k3s)

ARC runners must use **k3s** (not minikube). Minikube's Docker driver wraps the cluster in a container, so `hostNetwork: true` only exposes the minikube container's network — not the host LAN where the robot lives. k3s runs natively on the host, so `hostNetwork: true` gives pods direct access to the physical network.

The job pod uses `hostNetwork: true` and `dnsPolicy: ClusterFirstWithHostNet` (configured in the job templates) to reach the robot at `192.168.1.2` and the services on the host's loopback. The robot IP is configurable via the `ROBOT_HOST` environment variable.

Two runner scale sets run in the same cluster from the same `arc-config.yaml`: `lf-thor-widowx` for the real robot and `lf-thor-sim` for the simulation. They differ only in the job template ConfigMap they mount, both defined in `arc-job-templates.yaml`: `job-template` by default, `job-template-sim` for the sim set through the `--set` on its helm command. The work volume uses k3s's default `local-path` storage class. A runner set installed without kubernetes mode is switched by `helm uninstall` and `helm install`, not `helm upgrade`.

Runners register to the `lf-lang` organization in its Default runner group. ARC authenticates as the LF-ACT-App GitHub App, which has the organization permission "Self-hosted runners: Read and write". Its credentials are in the `lf-arc-github-app` secret in the `arc-runners` namespace.

```bash
# Install ARC controller
helm install arc \
    --namespace "arc-controller" \
    --create-namespace \
    oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller

# Job pod templates, one per runner scale set, mounted by its runner pods
kubectl create namespace arc-runners
kubectl apply -f arc-job-templates.yaml

# GitHub App credentials
kubectl create secret generic lf-arc-github-app -n arc-runners \
    --from-literal=github_app_id=5203721 \
    --from-literal=github_app_installation_id=168636877 \
    --from-file=github_app_private_key=lf-act-app.private-key.pem   # the App's private key from GitHub, kept here: *.pem is gitignored

# Deploy the runner scale sets
helm install "lf-thor-widowx" \
    --namespace "arc-runners" \
    --set maxRunners=1 \
    -f arc-config.yaml \
    oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
helm install "lf-thor-sim" \
    --namespace "arc-runners" \
    --set maxRunners=1 \
    --set 'template.spec.volumes[0].configMap.name=job-template-sim' \
    -f arc-config.yaml \
    oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set

# Upgrade after config changes: re-apply the templates, then helm upgrade with the same flags as the install
kubectl apply -f arc-job-templates.yaml
helm upgrade "lf-thor-widowx" \
    --namespace "arc-runners" \
    --set maxRunners=1 \
    -f arc-config.yaml \
    oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
helm upgrade "lf-thor-sim" \
    --namespace "arc-runners" \
    --set maxRunners=1 \
    --set 'template.spec.volumes[0].configMap.name=job-template-sim' \
    -f arc-config.yaml \
    oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```



### ARC shutdown

```bash
helm uninstall lf-thor-widowx --namespace arc-runners
helm uninstall lf-thor-sim --namespace arc-runners
helm uninstall arc --namespace arc-controller
```



### ARC status

```bash
kubectl get pods -n arc-controller     # controller + listener status
kubectl get pods -n arc-runners        # runner pods, and a <runner-pod>-workflow pod per running job
kubectl logs -n arc-controller -l app.kubernetes.io/name=gha-runner-scale-set-controller  # controller logs
kubectl logs -n arc-runners -l actions.github.com/scale-set-name=lf-thor-widowx           # runner logs (lf-thor-sim likewise)

# live logs of a currently running runner pod
kubectl get pods -n arc-runners                          # find the pod name
kubectl logs -f -n arc-runners <pod-name>                # follow logs
```



### Arm power

The arm is powered only while a job uses it. `pico/power_server.py` runs on the robot host, bound to `127.0.0.1:5200`, and drives the Pico relay: `POST /on` and `POST /off`, `GET /` for the state. The `execute` job switches the arm on right after the build (`pico/power_client.py on`), waits up to two minutes for the controller to boot (`pico/wait_for_arm.py`), runs the program, parks the arm and switches it off again; the last two steps run whatever happened to the program. The client reads the server's URL from `ROBOT_POWER_URL`, which only the `lf-thor-widowx` job template sets, so the same steps do nothing on the simulation runner.

Power-on is a lease: the server switches the arm off by itself after 8 minutes unless the job renews or ends it, so a job pod that dies without reaching its power-off step cannot leave the arm on. The server also switches the arm off when it starts and when it exits. `lf-thor-sim` needs no power and stays available around the clock, so the `simulate` stage runs at any time.

The relay can still be driven by hand with `python pico/serial_control.py on|off`; the server does not notice, so switch the arm off again afterwards. A web server to manage power and scheduling is planned; this one is its seed.

## Project structure

```
src/             Lingua Franca source (ci.lf, parallel.lf, robot.lf)
src-gen/         Generated C + Python code (gitignored)
bin/             Executable wrapper scripts (gitignored)
pico/            Pico W firmware, serial power control, and the arm power server and client for CI
examples/        Calibration tools, manual test utilities, positions.json
simulation/      Simulated arm and numpad endpoints with collision detection, for CI
.github/         CI workflows
```

