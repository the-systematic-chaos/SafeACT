import json
import sys
import time
import numpy as np
import trossen_arm
import threading

def save_positions(filename, data):
    """Save positions to JSON file"""
    with open(filename, 'w') as f:
        json.dump(data, f, indent=4)
    print(f"\nPositions saved to {filename}")

def display_positions(driver, running):
    """Display current positions in real-time"""
    while running[0]:
        try:
            positions = driver.get_all_positions()
            pos_str = ", ".join([f"{p:7.3f}" for p in positions])
            sys.stdout.write(f"\rCurrent position: [{pos_str}]")
            sys.stdout.flush()
            time.sleep(0.1)
        except:
            break
    # Clear the line when done
    sys.stdout.write("\r" + " " * 80 + "\r")
    sys.stdout.flush()

def record_position(driver, position_name, current_value):
    """Prompt user to record a position"""
    print(f"\nRecording '{position_name}' position")
    print("Move the robot to the desired position.")
    print("Press ENTER to record, 's' to skip (keep existing value)")
    
    if current_value:
        print(f"Current value: {current_value}")
    
    # Start displaying positions in real-time
    running = [True]
    display_thread = threading.Thread(target=display_positions, args=(driver, running))
    display_thread.daemon = True
    display_thread.start()
    
    try:
        while True:
            user_input = input().strip().lower()
            if user_input == '':
                # User pressed Enter - record position
                running[0] = False
                display_thread.join(timeout=0.2)
                positions = driver.get_all_positions()
                position_list = [float(p) for p in positions]
                print(f"Recorded: {position_list}")
                return position_list
            elif user_input == 's':
                # User pressed 's' - skip
                running[0] = False
                display_thread.join(timeout=0.2)
                print("Skipped - keeping existing value")
                return current_value
            else:
                print("Invalid input. Press ENTER to record or 's' to skip.")
    except KeyboardInterrupt:
        running[0] = False
        display_thread.join(timeout=0.2)
        raise

if __name__ == '__main__':
    json_filename = 'examples/positions.json'
    
    # Read existing positions
    print(f"Reading positions from {json_filename}...")
    try:
        with open(json_filename, 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"File {json_filename} not found. Creating new structure.")
        data = {"keys": [], "key_positions": {}}
    
    # Ensure structure exists
    if "keys" not in data:
        data["keys"] = []
    if "key_positions" not in data:
        data["key_positions"] = {}
    
    # Initialize the driver
    print("\nInitializing the drivers...")
    driver = trossen_arm.TrossenArmDriver()
    
    print("Configuring the drivers...")
    driver.configure(
        trossen_arm.Model.wxai_v0,
        trossen_arm.StandardEndEffector.wxai_v0_leader,
        "192.168.1.2",
        False
    )
    
    # Move robot to home position
    print("Moving robot to home position...")
    driver.set_arm_modes(trossen_arm.Mode.position)
    driver.set_arm_positions(
        np.zeros(driver.get_num_joints() - 1),
        2.0,
        True
    )
    print("Robot is now at home position.")
    
    # Start gravity compensation for manual movement
    print("Enabling gravity compensation for manual movement...")
    driver.set_all_modes(trossen_arm.Mode.external_effort)
    driver.set_all_external_efforts(
        [0, 0, 0, 0, 0, 0, 0],
        0.0,
        False
    )
    
    print("\n" + "="*60)
    print("Position Recording Tool")
    print("="*60)
    print(f"Found {len(data['keys'])} keys to record: {', '.join(data['keys'])}")
    print("="*60 + "\n")
    
    try:
        # Record positions for each key
        for key in data['keys']:
            print(f"\n{'='*60}")
            print(f"Recording positions for key: '{key}'")
            print(f"{'='*60}")
            
            # Initialize key_positions if it doesn't exist
            if key not in data['key_positions']:
                data['key_positions'][key] = {}
            
            # Record hover position
            current_hover = data['key_positions'][key].get('hover')
            hover_pos = record_position(driver, f"{key} - hover", current_hover)
            data['key_positions'][key]['hover'] = hover_pos
            save_positions(json_filename, data)
            
            # Record press position
            current_press = data['key_positions'][key].get('press')
            press_pos = record_position(driver, f"{key} - press", current_press)
            data['key_positions'][key]['press'] = press_pos
            save_positions(json_filename, data)
        
        print("\n" + "="*60)
        print("All positions recorded successfully!")
        print("="*60)
        
        # Move robot back to home position
        print("\nMoving robot back to home position...")
        driver.set_arm_modes(trossen_arm.Mode.position)
        driver.set_arm_positions(
            np.zeros(driver.get_num_joints() - 1),
            2.0,
            True
        )
        print("Robot is now at home position.")
        
    except KeyboardInterrupt:
        print("\n\nInterrupted by user. Saving current progress...")
        save_positions(json_filename, data)
        print("Progress saved. Exiting...")
    except Exception as e:
        print(f"\n\nError occurred: {e}")
        print("Saving current progress...")
        save_positions(json_filename, data)
        raise
    finally:
        print("\nStopping gravity compensation...")
        # Move robot to home position before exiting
        try:
            print("Moving robot to home position...")
            driver.set_arm_modes(trossen_arm.Mode.position)
            driver.set_arm_positions(
                np.zeros(driver.get_num_joints() - 1),
                2.0,
                True
            )
            print("Robot is now at home position.")
        except:
            pass  # Ignore errors during cleanup
        # Driver will automatically set mode to idle on exit
