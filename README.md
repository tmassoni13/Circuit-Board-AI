# PCB Inline Inspector

Current test build for the PCB camera/2D-axis alignment station.

This version is intentionally small. It keeps only the pieces being used right
now:

- the browser interface in `user_interface/`
- the local GRBL axis bridge
- manual GRBL axis test commands
- tiny GRBL serial-number engraving G-code generation
- support for the external ELP / 48MP USB camera through the browser

Old simulated inspection, ZED/Basler placeholders, YOLO training helpers, and
server dashboard code have been removed.

## UI Source Layout

The browser app lives in `user_interface/`:

```text
user_interface/index.html          Page structure
user_interface/styles.css          Industrial touchscreen styling
user_interface/js/config.js        Constants and shared runtime state
user_interface/js/machine_controls.js
user_interface/js/settings.js
user_interface/js/image_log.js
user_interface/js/hardware.js      Conveyor, GPIO, axis, and camera hooks
user_interface/js/capture_gemini.js
user_interface/js/inspection_results.js
user_interface/js/capture_sequence.js
user_interface/js/auto_conveyor.js
user_interface/js/board_vision.js
user_interface/js/boot.js          Startup calls
```

## Hardware Used Right Now

```text
Camera: ELP / 48MP USB camera
Axis controller: GRBL controller over USB serial
Serial adapter: CH340
Expected Jetson axis port: auto-detected /dev/ttyUSB0 or /dev/ttyACM0
Browser UI: local Python UI server on port 5500
Axis bridge: http://127.0.0.1:8765
```

The browser UI expects the external ELP / 48MP USB inspection camera. On the
Jetson Nano, plug the camera directly into one USB port and the CH340 GRBL axis
controller into another USB port.

Current conveyor IO pinout uses physical Jetson header pin numbers:

```text
Conveyor forward relay: pin 33
Conveyor reverse relay: pin 35
Start sensor: pin 29
Camera/imaging sensor: pin 37
End sensor: pin 31
```

The Omron E3Z-D61 sensor signals are expected to be reduced to Jetson-safe
0-3.3 V levels before they reach GPIO. The app configures those input pins with
no internal pull resistor so the external divider is not distorted.

## Jetson Nano Startup

Clone the GitHub repo onto the Jetson Nano, then install the app once:

```bash
cd ~
git clone <your-github-repo-url>
cd Circuit-Board-AI
bash deploy/jetson/install_app.sh
```

The installed services start automatically when the Jetson boots:

- `pcb-axis-bridge.service` starts the GRBL/2D-axis bridge.
- `pcb-inspector-ui.service` serves the browser UI on port 5500.
- the desktop icon `PCB AI` opens the app on the HDMI display.
- the desktop icon `Update PCB AI` pulls GitHub updates and restarts the services.

The UI does not auto-open on boot anymore. Open it from the `PCB AI` desktop
icon when you are ready to run the machine.

Press `Ctrl+Q` inside the app to close the kiosk browser. The UI server keeps
running so the `PCB AI` desktop icon can open it again.

## Gemini AI Inspection

The app sends captured board images from the Jetson UI server to Gemini for
good/bad inspection. Put the API key on the Jetson, not in GitHub:

```bash
sudo nano /etc/pcb-inline-inspector.env
```

Set:

```text
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.1-flash-lite
```

Then restart the UI server:

```bash
sudo systemctl restart pcb-inspector-ui.service
```

If the key is missing, captures still save to the image log, but Gemini analysis
will report an error in the terminal panel.

Check services:

```bash
sudo systemctl status pcb-axis-bridge.service
sudo systemctl status pcb-inspector-ui.service
```

Watch logs:

```bash
journalctl -u pcb-axis-bridge.service -f
journalctl -u pcb-inspector-ui.service -f
```

If the bridge sees the USB serial device but cannot open it, reboot once so the
`dialout` group change takes effect:

```bash
sudo reboot
```

Open the UI manually if kiosk mode does not open:

```bash
~/Circuit-Board-AI/deploy/jetson/launch_kiosk.sh
```

## Updating From GitHub

After pushing changes from the development computer, update the Jetson by
double-clicking the desktop icon named `Update PCB AI`, or run this from
the project folder:

```bash
cd ~/Circuit-Board-AI
bash deploy/jetson/update_app.sh
```

That script runs `git pull`, prints the installed commit, refreshes the editable
Python install, checks that expected UI markers exist, and restarts the axis
bridge and UI server.

After the update, open the desktop icon named `PCB AI`. The UI
server sends no-cache headers and the launcher uses a cache-busted URL so the
browser does not keep showing the old interface. If Chromium is still stuck,
reboot:

```bash
sudo reboot
```

The axis bridge defaults to `--port auto`, which looks for CH340/USB serial
devices such as `/dev/ttyUSB0` and `/dev/ttyACM0`.

To manually restart the bridge after plugging the axis back in:

```bash
sudo systemctl restart pcb-axis-bridge.service
```

## Manual Jetson Commands

The installer handles these automatically, but they are useful while debugging:

```bash
python3 -m pcb_inspector.main axis-bridge
python3 -m pcb_inspector.main serve-ui
chromium-browser --kiosk http://127.0.0.1:5500/user_interface/
```

## Windows Development Startup

For the original Windows test machine, use the same commands with `python`
instead of `python3`. If auto-detection picks the wrong serial device, pass the
port manually:

```text
python -m pcb_inspector.main axis-bridge --port COM4
```

## Normal Test Flow

1. Plug in the ELP / 48MP USB camera.
2. Plug in the CH340 GRBL axis controller.
3. Start the axis bridge.
4. Start the UI server and open Chromium.
5. Put the camera near the center of the usable axis area.
6. Enter the incoming board width/height and camera FOV width/height.
7. Click `START`.

The interface checks the axis and camera before searching. When `START` is
clicked, the current axis position is treated as X0/Y0 for that run. If either
the axis or camera is not connected, machine status turns red and movement does
not start.

Automatic mode is sensor driven:

1. If a board is already on the Camera sensor, the conveyor stops and imaging
   starts.
2. If a board is on the Start sensor, the conveyor moves forward until the
   Camera sensor detects it.
3. If a board is on the End sensor at startup, the conveyor reverses until the
   Camera sensor detects it.
4. Once imaging is complete, Gemini analysis starts in the background.
5. The conveyor moves the inspected board forward to the End sensor.
6. After the board reaches End, the app waits for the next board on Start or
   Camera. The completed board sitting at End is ignored so it is not pulled
   back into the camera station.

The board and FOV settings define whether the 2D axis needs to move. If the
camera FOV is larger than the board, the app holds at X0/Y0. If the board is
larger than the FOV, the app searches only the extra travel needed to cover the
board, capped by the configured machine safety limits.

Manual captures always save to `Manual Captures`. Automatic captures save to
the selected current folder. Pass/fail counts are calculated from analyzed
images in the currently selected folder; copied images in `Failures` are not
counted separately.

## Manual Axis Commands

Check GRBL status:

```bash
python3 -m pcb_inspector.main axis-status
```

Send a tiny movement test:

```bash
python3 -m pcb_inspector.main test-axis --distance-mm 1 --feed-mm-min 500
```

Send explicit G-code:

```bash
python3 -m pcb_inspector.main axis-send "G21" "G91" "G1 X10 F1000"
```

## Laser Serial Number Engraving

The project can generate tiny GRBL laser G-code for PCB serial numbers. By
default, it only writes the G-code file. It does not fire the laser unless both
`--send` and `--armed` are used.

Generate a 2 mm tall serial number file:

```powershell
python -m pcb_inspector.main laser-serial --text "SN-0001" --output laser_jobs\SN-0001.nc --height-mm 2 --power 120 --feed-mm-min 400
```

Open the generated `.nc` file in LaserGRBL or another G-code viewer first. Check
that the size, origin, and direction are correct before burning a real PCB.

Send it directly to the GRBL laser controller only when the laser is enclosed,
focused, vented, and physically safe:

```bash
python3 -m pcb_inspector.main laser-serial --text "SN-0001" --output laser_jobs/SN-0001.nc --height-mm 2 --power 120 --feed-mm-min 400 --send --armed
```

Useful tuning values:

```text
--height-mm          Printed serial height. Start around 2.0.
--power              GRBL spindle/laser power S value. Start low.
--feed-mm-min        Burn feed rate. Slower means darker/deeper.
--x-mm / --y-mm      Work-coordinate origin for the serial text.
--char-spacing-mm    Gap between characters.
```

For PCB marking, start with low power on scrap boards. FR4, solder mask, copper,
and silkscreen all react differently.

## Find The Axis Port

On Jetson/Linux:

```bash
ls /dev/ttyUSB* /dev/ttyACM*
dmesg | grep -i tty
```

On Windows:

```powershell
Get-PnpDevice -Class Ports
```

Look for a `USB-SERIAL CH340` device.
