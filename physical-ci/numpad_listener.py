#!/usr/bin/env python3
"""Connects to the numpad WebSocket server and prints key presses."""

import asyncio
from websockets.asyncio.client import connect

WS_URL = "ws://localhost:5100"


async def main():
    async with connect(WS_URL) as ws:
        print(f"Connected to {WS_URL}")
        async for key in ws:
            print(f"Key: {key}")


if __name__ == "__main__":
    asyncio.run(main())
