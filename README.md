# PCB Inline Inspector

Current test build for the PCB camera/2D-axis alignment station.

This version is intentionally small. It keeps only the pieces being used right
now:

- the browser interface in `interface_preview.html`
- the local GRBL axis bridge
- manual GRBL axis test commands
- tiny GRBL serial-number engraving G-code generation
- support for the external ELP / 48MP USB camera through the browser

Old simulated inspection, ZED/Basler placeholders, YOLO training helpers, and
server dashboard code have been removed.

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

## Jetson Nano Startup

Clone the GitHub repo onto the Jetson Nano, then install the app once:

```bash
cd ~
git clone <your-github-repo-url>
cd Circuit-Board-AI
bash deploy/jetson/install_app.sh
```

After that, reboot the Jetson:

```bash
sudo reboot
```

The installed app starts automatically when the Jetson boots:

- `pcb-axis-bridge.service` starts the GRBL/2D-axis bridge.
- `pcb-inspector-ui.service` serves the browser UI on port 5500.
- the desktop autostart entry opens Chromium in kiosk mode on the HDMI display.

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
chromium-browser http://127.0.0.1:5500/interface_preview.html
```

## Updating From GitHub

After pushing changes from the development computer, update the Jetson from the
project folder:

```bash
cd ~/Circuit-Board-AI
bash deploy/jetson/update_app.sh
```

That script runs `git pull`, refreshes the editable Python install, and restarts
the axis bridge and UI server.

If the browser is already open, refresh the page or reboot:

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
chromium-browser --kiosk http://127.0.0.1:5500/interface_preview.html
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
7. Click `SET ZERO`.
8. Click `START`.

The interface checks the axis and camera before searching. If either one is not
connected, machine status turns red and movement does not start.

The board and FOV settings define whether the 2D axis needs to move. If the
camera FOV is larger than the board, the app holds at X0/Y0. If the board is
larger than the FOV, the app searches only the extra travel needed to cover the
board, capped by the configured machine safety limits.

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
