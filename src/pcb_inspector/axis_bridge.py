import threading
import time
from typing import List, Optional

from flask import Flask, jsonify, request

from pcb_inspector.grbl_axis import resolve_grbl_port


class AxisBridgeConfig:
    def __init__(
        self,
        port: str = "auto",
        baud: int = 115200,
        max_step_mm: float = 60.0,
        feed_mm_min: float = 2000.0,
    ) -> None:
        # Serial port exposed by the CH340 USB serial adapter on the Atomstack
        # controller. Use `auto` on the Jetson Nano so the bridge finds the USB
        # serial device as `/dev/ttyUSB0` or `/dev/ttyACM0`.
        self.port = port

        # GRBL's common serial baud rate.
        self.baud = baud

        # Bound every browser-requested correction so a detector mistake cannot
        # command a large unexpected axis move.
        self.max_step_mm = max_step_mm

        # Default feed rate for relative alignment moves.
        self.feed_mm_min = feed_mm_min

    def as_dict(self):
        return {
            "port": self.port,
            "baud": self.baud,
            "max_step_mm": self.max_step_mm,
            "feed_mm_min": self.feed_mm_min,
        }


class AxisBridge:
    # AxisBridge keeps one serial connection open for the browser UI. This
    # avoids Chrome Web Serial permission issues while still letting the static
    # UI ask Python to move the Atomstack 2D axis.
    def __init__(self, config: AxisBridgeConfig) -> None:
        self.config = config
        self.lock = threading.Lock()
        self.serial = None

    def open(self) -> None:
        if self.serial is not None and self.serial.is_open:
            return

        try:
            import serial
        except ImportError as error:
            raise RuntimeError(
                "Axis bridge requires pyserial. Install it with: python -m pip install pyserial"
            ) from error

        resolved_port = resolve_grbl_port(self.config.port)

        self.serial = serial.Serial(
            port=resolved_port,
            baudrate=self.config.baud,
            timeout=2.0,
            write_timeout=2.0,
        )

        # GRBL resets when the serial port opens. Give it a moment, clear boot
        # text, then put the controller in a safe relative-motion state.
        time.sleep(2.0)
        self._read_available_lines()
        self.send("")
        self.send("M5")
        self.send("$X")
        self.send("G21")
        self.send("G91")

    def close(self) -> None:
        if self.serial is not None:
            self.serial.close()
            self.serial = None

    def send(self, command: str) -> List[str]:
        if self.serial is None or not self.serial.is_open:
            raise RuntimeError("Axis serial port is not open.")

        clean_command = command.strip()
        with self.lock:
            self.serial.write(f"{clean_command}\n".encode("ascii"))
            self.serial.flush()
            if not clean_command:
                return self._read_available_lines()
            return self._read_response_lines()

    def status(self) -> str:
        if self.serial is None or not self.serial.is_open:
            raise RuntimeError("Axis serial port is not open.")

        with self.lock:
            self.serial.write(b"?")
            self.serial.flush()
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                raw_line = self.serial.readline()
                if not raw_line:
                    continue

                line = raw_line.decode("ascii", errors="replace").strip()
                if line.startswith("<") and line.endswith(">"):
                    return line

        raise TimeoutError("Timed out waiting for GRBL status.")

    def feed_hold(self) -> str:
        if self.serial is None or not self.serial.is_open:
            raise RuntimeError("Axis serial port is not open.")

        # GRBL realtime feed hold. This is sent as a single character and is
        # handled immediately by the controller, unlike normal queued G-code.
        with self.lock:
            self.serial.write(b"!")
            self.serial.flush()

        return self.status()

    def emergency_stop(self) -> List[str]:
        if self.serial is None or not self.serial.is_open:
            raise RuntimeError("Axis serial port is not open.")

        # GRBL soft reset. This aborts queued motion immediately, unlike feed
        # hold, which pauses/decelerates and leaves the planner state intact.
        #
        # Do not take `self.lock` here. A long move/status wait can hold the
        # normal command lock; stop must cut through that and write the realtime
        # reset byte directly to the serial device.
        self.serial.write(b"\x18")
        self.serial.flush()
        time.sleep(0.25)
        lines = self._read_available_lines()

        return lines

    def move_relative(self, x_mm: float, y_mm: float, feed_mm_min: Optional[float] = None) -> List[str]:
        max_step = self.config.max_step_mm
        x_mm = max(-max_step, min(max_step, x_mm))
        y_mm = max(-max_step, min(max_step, y_mm))
        feed = feed_mm_min or self.config.feed_mm_min

        # Use G1 feed moves for visual alignment. Short rapid G0 corrections
        # feel jerky because every correction accelerates and decelerates hard.
        # Small G1 segments at a steady feed rate are smoother for camera
        # centering while we are still using HTTP commands instead of GRBL's
        # realtime jog mode.
        return self.send(f"G1 X{x_mm:.3f} Y{y_mm:.3f} F{feed:.1f}")

    def move_absolute(self, x_mm: float, y_mm: float, feed_mm_min: Optional[float] = None) -> List[str]:
        feed = feed_mm_min or self.config.feed_mm_min
        lines = []
        lines.extend(self.send("G90"))
        lines.extend(self.send(f"G1 X{x_mm:.3f} Y{y_mm:.3f} F{feed:.1f}"))
        lines.append(self.wait_until_idle())
        lines.extend(self.send("G91"))
        return lines

    def wait_until_idle(self, poll_seconds: float = 0.1, timeout_seconds: float = 10.0) -> str:
        deadline = time.monotonic() + timeout_seconds
        last_status = ""

        while time.monotonic() < deadline:
            status = self.status()
            last_status = status
            if status.startswith("<Idle") or status.startswith("<Alarm") or status.startswith("<Door"):
                return status
            time.sleep(poll_seconds)

        raise TimeoutError(f"Timed out waiting for GRBL idle. Last status: {last_status}")

    def _read_response_lines(self) -> List[str]:
        if self.serial is None:
            return []

        lines = []
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            raw_line = self.serial.readline()
            if not raw_line:
                continue

            line = raw_line.decode("ascii", errors="replace").strip()
            if not line:
                continue

            lines.append(line)
            if line == "ok" or line.startswith("error") or line.startswith("ALARM"):
                break

        return lines

    def _read_available_lines(self) -> List[str]:
        if self.serial is None:
            return []

        lines = []
        while self.serial.in_waiting:
            raw_line = self.serial.readline()
            if not raw_line:
                break
            line = raw_line.decode("ascii", errors="replace").strip()
            if line:
                lines.append(line)
        return lines


def create_axis_bridge_app(config: AxisBridgeConfig) -> Flask:
    app = Flask(__name__)
    bridge = AxisBridge(config)
    bridge.open()

    @app.after_request
    def add_cors_headers(response):
        # The UI server and axis bridge use different local ports on the Nano.
        # CORS is open here because both services are intended for localhost.
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        return response

    @app.route("/axis/status", methods=["GET", "OPTIONS"])
    def axis_status():
        if request.method == "OPTIONS":
            return ("", 204)
        return jsonify({"status": bridge.status(), "config": config.as_dict()})

    @app.route("/axis/move", methods=["POST", "OPTIONS"])
    def axis_move():
        if request.method == "OPTIONS":
            return ("", 204)

        payload = request.get_json(silent=True) or {}
        x_mm = float(payload.get("x_mm", 0.0))
        y_mm = float(payload.get("y_mm", 0.0))
        feed_mm_min = float(payload.get("feed_mm_min", config.feed_mm_min))
        lines = bridge.move_relative(x_mm=x_mm, y_mm=y_mm, feed_mm_min=feed_mm_min)
        return jsonify({"command": {"x_mm": x_mm, "y_mm": y_mm}, "lines": lines})

    @app.route("/axis/move-absolute", methods=["POST", "OPTIONS"])
    def axis_move_absolute():
        if request.method == "OPTIONS":
            return ("", 204)

        payload = request.get_json(silent=True) or {}
        x_mm = float(payload["x_mm"])
        y_mm = float(payload["y_mm"])
        feed_mm_min = float(payload.get("feed_mm_min", config.feed_mm_min))
        lines = bridge.move_absolute(x_mm=x_mm, y_mm=y_mm, feed_mm_min=feed_mm_min)
        return jsonify({"command": {"x_mm": x_mm, "y_mm": y_mm}, "lines": lines})

    @app.route("/axis/test", methods=["POST", "OPTIONS"])
    def axis_test():
        if request.method == "OPTIONS":
            return ("", 204)

        responses = [
            bridge.send("M5"),
            bridge.send("G21"),
            bridge.send("G91"),
            bridge.move_relative(x_mm=5.0, y_mm=0.0, feed_mm_min=1000.0),
            bridge.move_relative(x_mm=-5.0, y_mm=0.0, feed_mm_min=1000.0),
            [bridge.status()],
        ]
        return jsonify({"responses": responses})

    @app.route("/axis/stop", methods=["POST", "OPTIONS"])
    def axis_stop():
        if request.method == "OPTIONS":
            return ("", 204)
        lines = bridge.emergency_stop()
        return jsonify({"status": "soft reset sent", "lines": lines})

    @app.route("/axis/set-zero", methods=["POST", "OPTIONS"])
    def axis_set_zero():
        if request.method == "OPTIONS":
            return ("", 204)

        before_status = bridge.status()
        lines = []
        lines.extend(bridge.send("G54"))
        lines.extend(bridge.send("G10 L20 P1 X0 Y0"))
        lines.extend(bridge.send("G91"))
        after_status = bridge.status()
        lines.append(f"before={before_status}")
        lines.append(f"after={after_status}")
        return jsonify(
            {
                "lines": lines,
                "before_status": before_status,
                "after_status": after_status,
            }
        )

    return app


def serve_axis_bridge(
    port: str,
    baud: int,
    host: str,
    http_port: int,
    max_step_mm: float,
    feed_mm_min: float,
) -> None:
    config = AxisBridgeConfig(
        port=port,
        baud=baud,
        max_step_mm=max_step_mm,
        feed_mm_min=feed_mm_min,
    )
    app = create_axis_bridge_app(config)
    app.run(host=host, port=http_port, threaded=True)
