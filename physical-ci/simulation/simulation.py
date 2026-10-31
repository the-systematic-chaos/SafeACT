"""Simulated arm and numpad endpoints, run on the machine that CI reaches as
ROBOT_HOST and NUMPAD_SERVER_HOST.

Starts trossen_arm_sim with the numpad scene (arm controller on TCP 50001
and UDP 50000, collision stream on 50002), a numpad WebSocket server on port
5100 that speaks the protocol of numpad_server.py and pushes a key to every
subscriber whenever the simulated gripper touches it, and collision
detection that faults the simulated controller when the arm touches
anything but a key. The CI program runs against these endpoints as if they
were the real arm and numpad: a collision surfaces in the program as a
driver error, exactly as a hardware fault would.

    python simulation/simulation.py                # headless
    mjpython simulation/simulation.py --viewer     # with the MuJoCo viewer (macOS)
"""

import argparse
import logging
import threading
import time
from pathlib import Path

from websockets.exceptions import ConnectionClosed
from websockets.sync.server import ServerConnection, serve

from trossen_arm_sim.collision import CollisionMonitor
from trossen_arm_sim.collision_server import CollisionWebSocketServer
from trossen_arm_sim.protocol import ErrorState
from trossen_arm_sim.server import TrossenArmSimServer
from trossen_arm_sim.sim import WidowXSim

ROOT = Path(__file__).resolve().parent.parent
NUMPAD_PORT = 5100  # same port as numpad_server.py

ARM_LABEL_PREFIXES = ("base_link", "link_", "carriage_")
FINGERS = {"carriage_left", "carriage_right"}
# key_* geom name in the scene -> key name emitted by numpad_server.py
# (the suffix of the evdev KEY_KP* keycode); digits map to themselves.
KEY_NAMES = {"enter": "ENTER", "plus": "PLUS", "-": "MINUS", "slash": "SLASH",
             "star": "ASTERISK", "dot": "DOT"}


def pressed_key(event: dict) -> str | None:
    """Key name if the contact event is a gripper finger touching a key geom."""
    if event["geom1"] in FINGERS and event["geom2"].startswith("key_"):
        name = event["geom2"][len("key_"):]
        return KEY_NAMES.get(name, name)
    return None


class ContactListener(threading.Thread):
    """Runs on_contact for every begin/end event of the collision monitor."""

    def __init__(self, monitor: CollisionMonitor, name: str):
        super().__init__(daemon=True, name=name)
        self._monitor = monitor

    def run(self) -> None:
        _, events = self._monitor.subscribe()
        while True:
            self.on_contact(events.get().to_dict())

    def on_contact(self, event: dict) -> None:
        raise NotImplementedError


class SimulatedNumpad(ContactListener):
    """Stand-in for numpad_server.py: a key counts as pressed when the first
    gripper finger touches its geom, and can be pressed again once both
    fingers have left it. Every press is sent as a text message to all
    connected WebSocket subscribers; messages from subscribers are ignored.
    """

    def __init__(self, monitor: CollisionMonitor, host: str):
        super().__init__(monitor, "numpad")
        self._log = logging.getLogger("numpad")
        self._touching: dict[str, set[str]] = {}
        self._lock = threading.Lock()
        self._subscribers: set[ServerConnection] = set()
        self._server = serve(self._serve_subscriber, host, NUMPAD_PORT)
        self._ws = threading.Thread(target=self._server.serve_forever,
                                    daemon=True, name="numpad-ws")

    def start(self) -> None:
        super().start()
        self._ws.start()
        self._log.info("Listening on ws://%s:%d", self._server.socket.getsockname()[0], NUMPAD_PORT)

    def stop(self) -> None:
        self._server.shutdown()
        with self._lock:
            for websocket in self._subscribers:
                websocket.close()

    def _serve_subscriber(self, websocket: ServerConnection) -> None:
        peer = websocket.remote_address
        with self._lock:
            self._subscribers.add(websocket)
        self._log.info("Subscriber connected: %s (%d total)", peer, len(self._subscribers))
        try:
            for _ in websocket:
                pass  # ignore incoming messages; ends when the subscriber disconnects
        except ConnectionClosed:
            pass  # subscriber exited without a close frame
        finally:
            with self._lock:
                self._subscribers.discard(websocket)
            self._log.info("Subscriber disconnected: %s (%d total)", peer, len(self._subscribers))

    def on_contact(self, event: dict) -> None:
        key = pressed_key(event)
        if key is None:
            return
        fingers = self._touching.setdefault(key, set())
        if event["type"] == "begin":
            if not fingers:
                self._log.info("Key pressed: %s", key)
                self._broadcast(key)
            fingers.add(event["geom1"])
        else:
            fingers.discard(event["geom1"])

    def _broadcast(self, key: str) -> None:
        with self._lock:
            for websocket in self._subscribers:
                try:
                    websocket.send(key)
                except ConnectionClosed:
                    pass  # subscriber left; its handler is about to remove it


class CollisionDetection(ContactListener):
    """Faults the simulated controller on any contact that is not a gripper
    finger pressing a key, or a press harder than max_press_force."""

    def __init__(self, monitor: CollisionMonitor, arm: TrossenArmSimServer,
                 max_press_force: float):
        super().__init__(monitor, "collision-detection")
        self._log = logging.getLogger("collision")
        self._arm = arm
        self._max_press_force = max_press_force

    def stop(self) -> None:
        pass

    def on_contact(self, event: dict) -> None:
        if not event["body1"].startswith(ARM_LABEL_PREFIXES) \
                or {event["geom1"], event["geom2"]} == FINGERS:
            return  # scene objects touching each other, or the gripper closing
        pair = f"{event['geom1']} ({event['body1']}) -> {event['geom2']} ({event['body2']})"
        if pressed_key(event) is not None:
            if event["type"] == "end":
                self._log.info("Press: %s, %.2f N peak for %.2f s",
                               pair, event["peak_force"], event["duration"])
                if event["peak_force"] > self._max_press_force:
                    self._fault(f"{pair} pressed with {event['peak_force']:.1f} N "
                                f"(limit {self._max_press_force:.0f} N)")
        elif event["type"] == "begin":
            self._fault(f"{pair} hit with {event['force']:.1f} N")

    def _fault(self, description: str) -> None:
        if self._arm.error_state != ErrorState.NONE:
            return  # already faulted; the arm may keep touching things while it stops
        self._arm.fault(ErrorState.JOINT_DISABLED_UNEXPECTEDLY,
                        f"collision at {self._monitor.time:.3f}s: {description}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scene", nargs="?", default=str(ROOT / "examples" / "scene_numpad.xml"),
                        help="MuJoCo scene (default: examples/scene_numpad.xml)")
    parser.add_argument("--host", default="0.0.0.0", help="bind address")
    parser.add_argument("--viewer", action="store_true",
                        help="show the MuJoCo viewer (macOS: run with mjpython)")
    parser.add_argument("--max-press-force", type=float, default=10.0,
                        help="largest peak force [N] a key press may reach (a normal press is about 1 N)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s: %(message)s")

    sim = WidowXSim(args.scene)
    monitor = CollisionMonitor(sim)
    sim.start()
    arm = TrossenArmSimServer(sim, host=args.host)
    services = [
        arm,
        CollisionWebSocketServer(monitor, host=args.host),
        SimulatedNumpad(monitor, args.host),
        CollisionDetection(monitor, arm, args.max_press_force),
    ]
    for service in services:
        service.start()
    try:
        if args.viewer:
            sim.sync_viewer_loop()
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for service in reversed(services):
            service.stop()
        sim.stop()


if __name__ == "__main__":
    main()
