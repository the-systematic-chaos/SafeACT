"""Wait until the arm controller at ROBOT_HOST accepts TCP connections.

CI runs this before the program on the real arm, which the job has just powered on through
pico/power_server.py and which needs a moment to boot. Exits non-zero if
the controller is not up within DEADLINE seconds.
"""

import os
import socket
import sys
import time

HOST = os.environ.get("ROBOT_HOST", "192.168.1.2")
PORT = 50001  # the controller's TCP server, the first thing the driver connects to
DEADLINE = 120.0

start = time.monotonic()
while True:
    try:
        socket.create_connection((HOST, PORT), timeout=2).close()
    except OSError as e:
        if time.monotonic() - start > DEADLINE:
            sys.exit(f"Arm controller at {HOST}:{PORT} not reachable after {DEADLINE:.0f} s: {e}")
        time.sleep(2)
    else:
        print(f"Arm controller at {HOST}:{PORT} is up after {time.monotonic() - start:.0f} s")
        break
