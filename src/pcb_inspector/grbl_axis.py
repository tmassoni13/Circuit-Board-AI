from dataclasses import dataclass
from glob import glob
import time
from typing import List, Tuple


@dataclass(frozen=True)
class GrblResponse:
    command: str
    lines: Tuple[str, ...]


class GrblAxis:
    # GrblAxis talks to a GRBL-compatible XY stage over USB serial. The
    # Atomstack A5 Pro laser engraver uses this style of controller, so it can
    # be treated as a camera gantry after the laser is physically disabled.
    def __init__(self, port: str, baud: int = 115200, timeout_seconds: float = 2.0) -> None:
        self.port = resolve_grbl_port(port)
        self.baud = baud
        self.timeout_seconds = timeout_seconds
        self.serial = None

    def __enter__(self) -> "GrblAxis":
        try:
            import serial
        except ImportError as error:
            raise RuntimeError(
                "GRBL axis control requires pyserial. Install it with: pip install pyserial"
            ) from error

        self.serial = serial.Serial(
            port=self.port,
            baudrate=self.baud,
            timeout=self.timeout_seconds,
            write_timeout=self.timeout_seconds,
        )

        # GRBL resets when serial opens. Give it time to print its startup line,
        # then clear any boot text so command responses are easier to read.
        time.sleep(2.0)
        self._read_available_lines()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if self.serial is not None:
            self.serial.close()
            self.serial = None

    def startup_safe(self, unlock: bool = False) -> List[GrblResponse]:
        # Always force the laser/spindle output off before doing anything else.
        responses = [
            self.send("M5"),
            self.send("G21"),
            self.send("G91"),
        ]

        if unlock:
            responses.append(self.send("$X"))

        return responses

    def tiny_motion_test(self, distance_mm: float, feed_mm_min: float) -> List[GrblResponse]:
        # Relative move out and back. This verifies X/Y motion without changing
        # the final camera-stage position.
        return [
            self.send(f"G0 X{distance_mm:.3f} F{feed_mm_min:.1f}"),
            self.send(f"G0 X{-distance_mm:.3f} F{feed_mm_min:.1f}"),
            self.send(f"G0 Y{distance_mm:.3f} F{feed_mm_min:.1f}"),
            self.send(f"G0 Y{-distance_mm:.3f} F{feed_mm_min:.1f}"),
            self.send("M5"),
        ]

    def status(self) -> str:
        if self.serial is None:
            raise RuntimeError("GRBL serial connection is not open.")

        # GRBL status is a realtime command. It should be sent as a single '?'
        # byte, not as a normal newline-terminated G-code command.
        self.serial.write(b"?")
        self.serial.flush()

        deadline = time.monotonic() + self.timeout_seconds
        while time.monotonic() < deadline:
            raw_line = self.serial.readline()
            if not raw_line:
                continue

            line = raw_line.decode("ascii", errors="replace").strip()
            if line.startswith("<") and line.endswith(">"):
                return line

        raise TimeoutError("Timed out waiting for GRBL status response.")

    def wait_until_idle(self, poll_seconds: float = 0.1) -> str:
        while True:
            line = self.status()
            if line.startswith("<Idle") or line.startswith("<Alarm") or line.startswith("<Door"):
                return line
            time.sleep(poll_seconds)

    def send(self, command: str) -> GrblResponse:
        if self.serial is None:
            raise RuntimeError("GRBL serial connection is not open.")

        clean_command = command.strip()
        self.serial.write(f"{clean_command}\n".encode("ascii"))
        self.serial.flush()
        return GrblResponse(command=clean_command, lines=tuple(self._read_response_lines()))

    def _read_response_lines(self) -> List[str]:
        if self.serial is None:
            return []

        lines = []
        deadline = time.monotonic() + self.timeout_seconds
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


def resolve_grbl_port(port: str) -> str:
    """Return a usable GRBL serial port for Windows or Linux/Jetson.

    The development laptop used `COM4`, but the Jetson Nano will expose the
    same CH340 USB serial controller as something like `/dev/ttyUSB0` or
    `/dev/ttyACM0`. Passing `auto` lets the program find that USB serial device
    at startup so the operator does not have to type a platform-specific port.
    """
    if port and port.lower() != "auto":
        return port

    try:
        from serial.tools import list_ports
    except ImportError as error:
        raise RuntimeError(
            "GRBL axis auto-detection requires pyserial. Install it with: python -m pip install pyserial"
        ) from error

    ports = list(list_ports.comports())
    preferred_keywords = ("ch340", "ch341", "usb-serial", "usb serial", "cp210", "arduino")

    for candidate in ports:
        label = " ".join(
            str(value).lower()
            for value in (candidate.description, candidate.manufacturer, candidate.hwid)
            if value
        )
        if any(keyword in label for keyword in preferred_keywords):
            return candidate.device

    linux_candidates = sorted(glob("/dev/ttyUSB*") + glob("/dev/ttyACM*"))
    if linux_candidates:
        return linux_candidates[0]

    windows_candidates = [candidate.device for candidate in ports if candidate.device.upper().startswith("COM")]
    if windows_candidates:
        return windows_candidates[0]

    raise RuntimeError(
        "No GRBL USB serial device found. Plug the 2D axis into the Jetson Nano USB port and retry."
    )
