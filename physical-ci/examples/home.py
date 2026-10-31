"""Park the arm: clear any controller error, move every joint to zero and close the gripper.

Run by hand, or by CI as the last step of every program job regardless of how the program
ended, so that a failed, cancelled or timed-out run never leaves the arm over the numpad.
ROBOT_HOST selects the arm (default 192.168.1.2), as in the program.
"""

import os

import numpy as np
import trossen_arm

if __name__ == "__main__":
    host = os.environ.get("ROBOT_HOST", "192.168.1.2")
    driver = trossen_arm.TrossenArmDriver()
    print(f"Configuring driver to {host}, clearing any controller error")
    driver.configure(
        trossen_arm.Model.wxai_v0,
        trossen_arm.StandardEndEffector.wxai_v0_follower,
        host,
        True,  # clear_error: a run that ended in a fault must not leave the arm where it stopped
    )

    print("Moving to home position")
    driver.set_arm_modes(trossen_arm.Mode.position)
    driver.set_arm_positions(np.zeros(driver.get_num_joints() - 1), 2.0, True)

    print("Closing gripper")
    driver.set_gripper_mode(trossen_arm.Mode.position)
    driver.set_gripper_position(0.0, 1.0, True)
    print("Arm is at home position")
