import machine
import sys
import select

GPIO20 = machine.Pin(20, machine.Pin.OUT)
led = machine.Pin("LED", machine.Pin.OUT)  # use Pin(25) if not Pico W

led.value(1)  # onboard LED on = program is running

poll_obj = select.poll()
poll_obj.register(sys.stdin, select.POLLIN)

while True:
    if poll_obj.poll(0):
        command = sys.stdin.read(1)
        
        if command == '1':
            GPIO20.value(1)
            print("GPIO ON")
        elif command == '0':
            GPIO20.value(0)
            print("GPIO OFF")