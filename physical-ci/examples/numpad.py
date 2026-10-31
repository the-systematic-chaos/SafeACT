from evdev import InputDevice, categorize, ecodes

# Using the stable ID path
dev = InputDevice('/dev/input/by-id/usb-Usb_KeyBoard_Usb_KeyBoard-event-kbd')

print(f"Connected to: {dev.name}")
print("Press some keys on the Numpad (Ctrl+C to stop)...")

try:
    for event in dev.read_loop():
        if event.type == ecodes.EV_KEY:
            key_event = categorize(event)
            if key_event.keystate == 1:  # Key Down
                print(f"Key: {key_event.keycode} | ID: {key_event.scancode}")
except KeyboardInterrupt:
    print("\nExiting...")