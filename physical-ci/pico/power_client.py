#!/usr/bin/env python3
"""Switch the arm's power through the power server, from a CI job.

    python3 pico/power_client.py on|off

The server's URL comes from ROBOT_POWER_URL, set in the lf-thor-widowx job template. Without it,
as on the simulation runner, there is no arm to power and the command does nothing.
"""

import os
import sys
import urllib.request

action = sys.argv[1] if len(sys.argv) == 2 else None
if action not in ("on", "off"):
    sys.exit(f"usage: {sys.argv[0]} on|off")

url = os.environ.get("ROBOT_POWER_URL")
if not url:
    print(f"ROBOT_POWER_URL is not set: no arm power to switch {action}")
    sys.exit(0)

request = urllib.request.Request(f"{url.rstrip('/')}/{action}", method="POST")
with urllib.request.urlopen(request, timeout=10) as response:
    print(f"arm power {action}: {response.read().decode()}")
