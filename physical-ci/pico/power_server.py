#!/usr/bin/env python3
"""Arm power over HTTP, for CI jobs on this host.

Listens on 127.0.0.1:5200, which job pods reach through host networking, and drives the Pico
relay through serial_control.py. The arm is switched off when the server starts.

    POST /on[?lease=SECONDS]   power on, and off again after the lease (default 480 s) unless a
                               new /on renews it or /off ends it
    POST /off                  power off
    GET  /                     {"power": "on"|"off", "lease_left": seconds or null}

The lease is a watchdog: a job that dies without running its power-off step cannot leave the arm
on. The default outlives a job's 5-minute timeout plus its final steps.
"""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from serial_control import RobotPower

DEFAULT_LEASE = 480.0


class ArmPower:
    def __init__(self, mode: str):
        self._mode = mode
        self._lock = threading.Lock()
        self._generation = 0  # bumps on every switch; a stale lease timer must not act
        self._expires = None
        self.state = None
        self.off()

    def _switch(self, state: str) -> None:
        relay = RobotPower(mode=self._mode)
        try:
            relay.power_on() if state == "on" else relay.power_off()
        finally:
            relay.close()
        self.state = state
        self._generation += 1
        print(f"{time.strftime('%F %T')} arm power {state}", flush=True)

    def on(self, lease: float) -> None:
        with self._lock:
            self._switch("on")
            self._expires = time.monotonic() + lease
            timer = threading.Timer(lease, self._expire, args=(self._generation,))
            timer.daemon = True
            timer.start()

    def off(self) -> None:
        with self._lock:
            self._expires = None
            self._switch("off")

    def _expire(self, generation: int) -> None:
        with self._lock:
            if generation != self._generation:
                return  # renewed or switched off since this timer was set
            print(f"{time.strftime('%F %T')} lease expired", flush=True)
            self._expires = None
            self._switch("off")

    def status(self) -> dict:
        left = self._expires - time.monotonic() if self._expires is not None else None
        return {"power": self.state, "lease_left": round(max(left, 0.0)) if left is not None else None}


class Handler(BaseHTTPRequestHandler):
    power: ArmPower  # set in main

    def _reply(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if urlparse(self.path).path != "/":
            return self._reply(404, {"error": "not found"})
        self._reply(200, self.power.status())

    def do_POST(self) -> None:
        url = urlparse(self.path)
        try:
            if url.path == "/on":
                lease = float(parse_qs(url.query).get("lease", [DEFAULT_LEASE])[0])
                self.power.on(lease)
            elif url.path == "/off":
                self.power.off()
            else:
                return self._reply(404, {"error": "not found"})
        except Exception as e:  # serial port missing, bad lease value, ...
            return self._reply(500, {"error": repr(e)})
        self._reply(200, self.power.status())

    def log_message(self, fmt, *args):  # one line per request, with the time
        print(f"{time.strftime('%F %T')} {self.address_string()} {fmt % args}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=5200)
    parser.add_argument("--mode", choices=["normally_on", "normally_off"], default="normally_off",
                        help="relay mode, as for serial_control.py")
    args = parser.parse_args()
    Handler.power = ArmPower(args.mode)
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        print(f"Arm power server listening on http://{args.host}:{args.port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            Handler.power.off()


if __name__ == "__main__":
    main()
