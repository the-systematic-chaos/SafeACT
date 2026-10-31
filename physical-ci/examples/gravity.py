import trossen_arm
import time
import sys

if __name__ == '__main__':
    # Initialize the driver
    driver = trossen_arm.TrossenArmDriver()

    # Configure the driver
    driver.configure(
        trossen_arm.Model.wxai_v0,
        trossen_arm.StandardEndEffector.wxai_v0_leader,
        "192.168.1.2",
        False
    )

    # Start gravity compensation
    driver.set_all_modes(trossen_arm.Mode.external_effort)
    driver.set_all_external_efforts(
        [0, 0, 0, 0, 0, 0, 0],
        0.0,
        False
    )

    print("Gravity compensation active. Move the arm freely.")
    print("Press Ctrl+C to stop.\n")

    try:
        while True:
            # Get the current state of the arm
            positions = driver.get_all_positions()

            # Format and print the angles on a single line
            pos_str = ", ".join([f"{p:6.3f}" for p in positions])
            sys.stdout.write(f"\rJoint Angles (rad): [{pos_str}]")
            sys.stdout.flush()
            
            # Small sleep to prevent flooding the CPU/terminal
            time.sleep(0.1)
            
    except KeyboardInterrupt:
        print("\n\nStopping gravity compensation...")
        # Driver will automatically set mode to idle on exit