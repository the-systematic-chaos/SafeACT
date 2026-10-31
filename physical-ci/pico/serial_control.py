import serial


class RobotPower:
    def __init__(self, mode = "normally_off"):
        if mode not in ["normally_on", "normally_off"]:
            raise ValueError("Invalid mode, must be 'normally_on' or 'normally_off'")
        self.mode = mode
        self.serial = SerialControl()
    def power_on(self):
        if self.mode == "normally_on":
            self.serial.GPIO_OFF()
        elif self.mode == "normally_off":
            self.serial.GPIO_ON()
    def power_off(self):
        if self.mode == "normally_on":
            self.serial.GPIO_ON()
        elif self.mode == "normally_off":
            self.serial.GPIO_OFF()
    def close(self):
        self.serial.close()

class SerialControl:
    def __init__(self, port='/dev/ttyACM0', baudrate=115200, timeout=2):
        import os
        if not os.path.exists(port):
            raise FileNotFoundError(f"Serial port {port} not found. Is the Pico plugged in?")
        self.ser = serial.Serial(port, baudrate, timeout=timeout)
    def GPIO_ON(self):
        self.ser.write(b'1')
    def GPIO_OFF(self):
        self.ser.write(b'0')
    def close(self):
        self.ser.close()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Robot power control via Pico relay")
    parser.add_argument("action", choices=["on", "off"], help="Power on or off")
    parser.add_argument("--mode", choices=["normally_on", "normally_off"], default="normally_off", help="Relay mode (default: normally_off)")
    args = parser.parse_args()

    robot_power = RobotPower(mode=args.mode)
    if args.action == "on":
        robot_power.power_on()
    else:
        robot_power.power_off()
    robot_power.close()