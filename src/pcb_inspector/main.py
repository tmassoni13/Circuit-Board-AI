import argparse
import json
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn
from typing import List

from pcb_inspector.grbl_axis import GrblAxis
from pcb_inspector.laser_engraver import (
    SerialEngravingConfig,
    generate_serial_gcode,
    stream_gcode_file,
    write_gcode_file,
)

CONVEYOR_RELAY_PINS = {
    1: 35,
    2: 33,
    3: 31,
    4: 29,
}


class ConveyorRelayController:
    """Small Jetson GPIO adapter for the conveyor relay test outputs.

    The relay inputs are wired to Jetson Nano physical header pins, so this
    class deliberately uses GPIO.BOARD numbering instead of Broadcom/SoC names.
    ON currently means the pin is driven HIGH and OFF means it is driven LOW.
    If the installed relay board is active-low, the operator will see inverted
    behavior during test and we can flip `active_low` in one place.
    """

    def __init__(self, active_low=False):
        self.active_low = active_low
        self._gpio = None
        self._initialized = False
        self._states = {channel: False for channel in CONVEYOR_RELAY_PINS}

    def _load_gpio(self):
        if self._gpio is not None:
            return self._gpio

        try:
            import Jetson.GPIO as GPIO
        except Exception as error:
            raise RuntimeError(
                "Jetson.GPIO is not available. Install/run this on the Jetson Nano to control the conveyor relay."
            ) from error

        self._gpio = GPIO
        return GPIO

    def _ensure_initialized(self):
        if self._initialized:
            return

        GPIO = self._load_gpio()
        GPIO.setwarnings(False)
        GPIO.setmode(GPIO.BOARD)
        off_level = GPIO.HIGH if self.active_low else GPIO.LOW
        for pin in CONVEYOR_RELAY_PINS.values():
            GPIO.setup(pin, GPIO.OUT, initial=off_level)
        self._initialized = True

    def set_channel(self, channel, enabled):
        if channel not in CONVEYOR_RELAY_PINS:
            raise ValueError("Relay channel must be 1, 2, 3, or 4.")

        self._ensure_initialized()
        GPIO = self._load_gpio()
        pin = CONVEYOR_RELAY_PINS[channel]
        if self.active_low:
            level = GPIO.LOW if enabled else GPIO.HIGH
        else:
            level = GPIO.HIGH if enabled else GPIO.LOW

        GPIO.output(pin, level)
        self._states[channel] = bool(enabled)
        return self.status()

    def all_off(self):
        self._ensure_initialized()
        for channel in CONVEYOR_RELAY_PINS:
            self.set_channel(channel, False)
        return self.status()

    def status(self):
        return {
            "pins": CONVEYOR_RELAY_PINS,
            "active_low": self.active_low,
            "states": self._states,
            "initialized": self._initialized,
        }


CONVEYOR_RELAYS = ConveyorRelayController()


def test_axis(
    port: str,
    baud: int,
    distance_mm: float,
    feed_mm_min: float,
    unlock: bool,
) -> None:
    """Send a tiny four-direction motion test to the GRBL 2D axis."""
    with GrblAxis(port=port, baud=baud) as axis:
        responses = axis.startup_safe(unlock=unlock)
        responses.extend(axis.tiny_motion_test(distance_mm, feed_mm_min))

    for response in responses:
        print(f"> {response.command}")
        for line in response.lines:
            print(line)


def axis_status(port: str, baud: int) -> None:
    """Print GRBL firmware info, settings, and current position status."""
    with GrblAxis(port=port, baud=baud) as axis:
        responses = [
            axis.send("M5"),
            axis.send("$I"),
            axis.send("$$"),
            axis.send("?"),
        ]

    for response in responses:
        print(f"> {response.command}")
        for line in response.lines:
            print(line)


def axis_send(port: str, baud: int, commands: List[str], wait_idle: bool) -> None:
    """Send explicit GRBL commands for manual axis testing."""
    with GrblAxis(port=port, baud=baud) as axis:
        responses = [axis.send("M5")]
        final_status = None

        for command in commands:
            responses.append(axis.send(command))
            if wait_idle and command_should_wait_for_idle(command):
                final_status = axis.wait_until_idle()

        if wait_idle:
            final_status = axis.wait_until_idle()

        responses.append(axis.send("M5"))

    for response in responses:
        print(f"> {response.command}")
        for line in response.lines:
            print(line)

    if final_status is not None:
        print(f"final_status={final_status}")


def command_should_wait_for_idle(command: str) -> bool:
    """Return true for commands that should finish before sending the next one."""
    normalized = command.strip().upper()
    return normalized.startswith(("G0", "G1", "G2", "G3", "G4"))


def laser_serial(
    text: str,
    output: Path,
    x_mm: float,
    y_mm: float,
    height_mm: float,
    power: int,
    feed_mm_min: float,
    travel_feed_mm_min: float,
    char_spacing_mm: float,
    send: bool,
    armed: bool,
    port: str,
    baud: int,
) -> None:
    """Generate tiny serial-number G-code and optionally stream it to GRBL."""
    config = SerialEngravingConfig(
        text=text,
        x_mm=x_mm,
        y_mm=y_mm,
        height_mm=height_mm,
        power=power,
        feed_mm_min=feed_mm_min,
        travel_feed_mm_min=travel_feed_mm_min,
        char_spacing_mm=char_spacing_mm,
    )
    output_path = write_gcode_file(generate_serial_gcode(config), output)
    print(f"gcode={output_path}")

    if not send:
        print("laser=not_sent")
        print("reason=dry_run_default")
        return

    if not armed:
        raise RuntimeError("Refusing to fire laser without --armed.")

    stream_gcode_file(port=port, baud=baud, gcode_path=output_path)
    print("laser=sent")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="PCB inline inspector support tools.",
    )
    subparsers = parser.add_subparsers(dest="command")
    subparsers.required = True

    axis_bridge_parser = subparsers.add_parser(
        "axis-bridge",
        help="Run the local HTTP bridge used by the browser UI.",
    )
    axis_bridge_parser.add_argument("--port", default="auto")
    axis_bridge_parser.add_argument("--baud", type=int, default=115200)
    axis_bridge_parser.add_argument("--host", default="127.0.0.1")
    axis_bridge_parser.add_argument("--http-port", type=int, default=8765)
    axis_bridge_parser.add_argument("--max-step-mm", type=float, default=60.0)
    axis_bridge_parser.add_argument("--feed-mm-min", type=float, default=2000.0)

    test_axis_parser = subparsers.add_parser(
        "test-axis",
        help="Send a safe four-direction GRBL motion test.",
    )
    test_axis_parser.add_argument("--port", default="auto")
    test_axis_parser.add_argument("--baud", type=int, default=115200)
    test_axis_parser.add_argument("--distance-mm", type=float, default=1.0)
    test_axis_parser.add_argument("--feed-mm-min", type=float, default=500.0)
    test_axis_parser.add_argument(
        "--unlock",
        action="store_true",
        help="Send GRBL $X unlock after startup if the controller is in ALARM.",
    )

    axis_status_parser = subparsers.add_parser(
        "axis-status",
        help="Read GRBL status and settings.",
    )
    axis_status_parser.add_argument("--port", default="auto")
    axis_status_parser.add_argument("--baud", type=int, default=115200)

    axis_send_parser = subparsers.add_parser(
        "axis-send",
        help="Send explicit GRBL commands.",
    )
    axis_send_parser.add_argument("--port", default="auto")
    axis_send_parser.add_argument("--baud", type=int, default=115200)
    axis_send_parser.add_argument(
        "--no-wait",
        action="store_true",
        help="Do not wait for GRBL to return to Idle after motion commands.",
    )
    axis_send_parser.add_argument("commands", nargs="+")

    laser_serial_parser = subparsers.add_parser(
        "laser-serial",
        help="Generate tiny GRBL laser G-code for a PCB serial number.",
    )
    laser_serial_parser.add_argument("--text", required=True)
    laser_serial_parser.add_argument("--output", type=Path, default=Path("laser_jobs/serial.nc"))
    laser_serial_parser.add_argument("--x-mm", type=float, default=0.0)
    laser_serial_parser.add_argument("--y-mm", type=float, default=0.0)
    laser_serial_parser.add_argument("--height-mm", type=float, default=2.0)
    laser_serial_parser.add_argument("--power", type=int, default=120)
    laser_serial_parser.add_argument("--feed-mm-min", type=float, default=400.0)
    laser_serial_parser.add_argument("--travel-feed-mm-min", type=float, default=3000.0)
    laser_serial_parser.add_argument("--char-spacing-mm", type=float, default=0.25)
    laser_serial_parser.add_argument("--port", default="auto")
    laser_serial_parser.add_argument("--baud", type=int, default=115200)
    laser_serial_parser.add_argument(
        "--send",
        action="store_true",
        help="Stream the generated G-code to the laser controller.",
    )
    laser_serial_parser.add_argument(
        "--armed",
        action="store_true",
        help="Required with --send so laser firing is explicit.",
    )

    serve_ui_parser = subparsers.add_parser(
        "serve-ui",
        help="Serve the browser UI locally for the Jetson Nano touchscreen.",
    )
    serve_ui_parser.add_argument("--host", default="127.0.0.1")
    serve_ui_parser.add_argument("--port", type=int, default=5500)
    serve_ui_parser.add_argument("--root", type=Path, default=Path("."))

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.command == "axis-bridge":
        from pcb_inspector.axis_bridge import serve_axis_bridge

        serve_axis_bridge(
            port=args.port,
            baud=args.baud,
            host=args.host,
            http_port=args.http_port,
            max_step_mm=args.max_step_mm,
            feed_mm_min=args.feed_mm_min,
        )
    elif args.command == "test-axis":
        test_axis(
            port=args.port,
            baud=args.baud,
            distance_mm=args.distance_mm,
            feed_mm_min=args.feed_mm_min,
            unlock=args.unlock,
        )
    elif args.command == "axis-status":
        axis_status(port=args.port, baud=args.baud)
    elif args.command == "axis-send":
        axis_send(
            port=args.port,
            baud=args.baud,
            commands=args.commands,
            wait_idle=not args.no_wait,
        )
    elif args.command == "laser-serial":
        laser_serial(
            text=args.text,
            output=args.output,
            x_mm=args.x_mm,
            y_mm=args.y_mm,
            height_mm=args.height_mm,
            power=args.power,
            feed_mm_min=args.feed_mm_min,
            travel_feed_mm_min=args.travel_feed_mm_min,
            char_spacing_mm=args.char_spacing_mm,
            send=args.send,
            armed=args.armed,
            port=args.port,
            baud=args.baud,
        )
    elif args.command == "serve-ui":
        serve_ui(host=args.host, port=args.port, root=args.root)


def serve_ui(host: str, port: int, root: Path) -> None:
    """Serve the browser UI from the Jetson Nano over localhost.

    Browser camera access works reliably from `localhost`, and this removes the
    dependency on an editor extension once the app is running on the Nano.
    """
    root = root.resolve()
    os.chdir(str(root))

    class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    class InspectorUiHandler(SimpleHTTPRequestHandler):
        def end_headers(self):
            # The Jetson kiosk browser can otherwise keep showing an older
            # `user_interface.html` after a GitHub update. These headers force
            # Chromium to ask the local UI server for the current file each
            # time the page is opened or refreshed.
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            SimpleHTTPRequestHandler.end_headers(self)

        def do_POST(self):
            endpoint = self.path.split("?", 1)[0]
            if endpoint not in {"/api/analyze-board", "/api/conveyor-relay", "/api/conveyor-relay-all-off"}:
                self.send_error(404, "Unknown endpoint")
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length).decode("utf-8")
                payload = json.loads(raw_body or "{}")

                if endpoint == "/api/analyze-board":
                    from pcb_inspector.gemini_inspection import analyze_pcb_images

                    result = analyze_pcb_images(
                        payload.get("images") or [],
                        extra_context=payload.get("prompt_context") or "",
                    )
                    self.send_json(200, result)
                    return

                if endpoint == "/api/conveyor-relay":
                    channel = int(payload.get("channel"))
                    state = bool(payload.get("state"))
                    self.send_json(200, CONVEYOR_RELAYS.set_channel(channel, state))
                    return

                if endpoint == "/api/conveyor-relay-all-off":
                    self.send_json(200, CONVEYOR_RELAYS.all_off())
                    return
            except Exception as error:
                self.send_json(500, {"error": str(error)})

        def do_GET(self):
            endpoint = self.path.split("?", 1)[0]
            if endpoint == "/api/conveyor-relay-status":
                self.send_json(200, CONVEYOR_RELAYS.status())
                return

            SimpleHTTPRequestHandler.do_GET(self)

        def send_json(self, status_code, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadedHTTPServer((host, port), InspectorUiHandler)
    print(f"ui=http://{host}:{port}/user_interface.html")
    print("Press Ctrl+C to stop the UI server.")
    server.serve_forever()


if __name__ == "__main__":
    main()
