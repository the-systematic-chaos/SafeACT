import argparse
import json
import numpy as np
import trossen_arm

def keep_gripper_closed(driver, block=False):
    """Ensure gripper stays closed"""
    driver.set_gripper_mode(trossen_arm.Mode.position)
    driver.set_gripper_position(0.0, 2.0, True)

def move_to_home(driver):
    """Move robot to home position"""
    print("Moving to home position...")
    driver.set_arm_modes(trossen_arm.Mode.position)
    driver.set_arm_positions(
        np.zeros(driver.get_num_joints() - 1),
        2.0,
        True
    )
    keep_gripper_closed(driver, block=True)

    print("Robot is at home position.")

def press_button(driver, key_name, key_positions):
    # keep_gripper_closed(driver)
    """Press a button by moving to hover -> press -> hover"""
    if key_name not in key_positions:
        return False
    
    positions = key_positions[key_name]
    if "hover" not in positions or "press" not in positions:
        return False
    
    hover_pos = np.array(positions["hover"])
    press_pos = np.array(positions["press"])
    
    print(f"Moving to hover position above '{key_name}' button...")
    driver.set_arm_positions(
        hover_pos[:6],
        2.0,
        True
    )
    
    print(f"Pressing the '{key_name}' button...")
    driver.set_arm_positions(
        press_pos[:6],
        2.0,
        True
    )
    
    print(f"Returning to hover position above '{key_name}' button...")
    driver.set_arm_positions(
        hover_pos[:6],
        2.0,
        True
    )
    
    return True

if __name__=='__main__':
    parser = argparse.ArgumentParser(description="Press numpad buttons with the WidowX arm")
    parser.add_argument("--sim", action="store_true",
                        help="connect to the local trossen_arm_sim server instead of the real robot")
    args = parser.parse_args()
    host = "127.0.0.1" if args.sim else "192.168.1.2"

    # Read positions from JSON file
    print("Reading positions from positions.json...")
    with open('examples/positions.json', 'r') as f:
        data = json.load(f)
    
    # Get available keys and key positions
    key_positions = data.get("key_positions", {})
    available_keys = list(key_positions.keys())
    
    if not available_keys:
        print("No keys found in positions.json!")
        exit(1)
    
    print(f"Available keys: {', '.join(available_keys)}")
    
    print("\nInitializing the drivers...")
    driver = trossen_arm.TrossenArmDriver()

    print(f"Configuring the drivers ({host})...")
    driver.configure(
        trossen_arm.Model.wxai_v0,
        trossen_arm.StandardEndEffector.wxai_v0_follower,
        host,
        False
    )

    print("Moving to home position...")
    move_to_home(driver)

    print("\n" + "="*60)
    print("Button Pressing Tool")
    print("="*60)
    print("Enter a key name to press, or Ctrl+C to exit and return home")
    print("="*60 + "\n")
    
    try:
        while True:
            user_input = input("Enter key to press: ").strip()
            
            if not user_input:
                print("Please enter a key name.")
                continue
            
            if user_input in key_positions:
                print(f"\nPressing '{user_input}' button...")
                if press_button(driver, user_input, key_positions):
                    print(f"Successfully pressed '{user_input}' button!\n")
                else:
                    print(f"Error: '{user_input}' button positions are incomplete.\n")
            else:
                print(f"Error: '{user_input}' not found in positions.json.")
                print(f"Available keys: {', '.join(available_keys)}\n")
    
    except KeyboardInterrupt:
        print("\n\nInterrupted by user.")
        move_to_home(driver)
        print("Done!")