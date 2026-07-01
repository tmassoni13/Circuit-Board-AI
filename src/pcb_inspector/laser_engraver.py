from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import time


# 5x7 block font used for tiny PCB serial numbers.
#
# Each string is one row. "1" means burn that pixel, "0" means skip it.
# The generator converts connected horizontal pixels into short laser strokes.
# This is intentionally simple and dependency-free so it can run on the Pi.
FONT_5X7: dict[str, tuple[str, ...]] = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "10000", "11110", "00001", "00001", "11110"),
    "6": ("01110", "10000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00001", "01110"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01111", "10000", "10000", "10011", "10001", "10001", "01110"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("01110", "00100", "00100", "00100", "00100", "00100", "01110"),
    "J": ("00001", "00001", "00001", "00001", "10001", "10001", "01110"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "10101", "01010"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    "_": ("00000", "00000", "00000", "00000", "00000", "00000", "11111"),
    ".": ("00000", "00000", "00000", "00000", "00000", "01100", "01100"),
    " ": ("00000", "00000", "00000", "00000", "00000", "00000", "00000"),
}


@dataclass(frozen=True)
class SerialEngravingConfig:
    text: str
    x_mm: float = 0.0
    y_mm: float = 0.0
    height_mm: float = 2.0
    power: int = 120
    feed_mm_min: float = 400.0
    travel_feed_mm_min: float = 3000.0
    char_spacing_mm: float = 0.25


def generate_serial_gcode(config: SerialEngravingConfig) -> list[str]:
    """Generate GRBL laser G-code for a tiny serial number."""
    text = normalize_serial_text(config.text)
    pixel_size = config.height_mm / 7.0
    char_width = 5.0 * pixel_size
    x_cursor = config.x_mm
    lines = [
        "(PCB serial engraving)",
        f"(text: {text})",
        "G21",
        "G90",
        "M5",
    ]

    for character in text:
        bitmap = FONT_5X7[character]
        lines.extend(
            character_strokes(
                bitmap=bitmap,
                origin_x=x_cursor,
                origin_y=config.y_mm,
                pixel_size=pixel_size,
                power=config.power,
                feed_mm_min=config.feed_mm_min,
                travel_feed_mm_min=config.travel_feed_mm_min,
            )
        )
        x_cursor += char_width + config.char_spacing_mm

    lines.extend(["M5", "G0 X0 Y0"])
    return lines


def normalize_serial_text(text: str) -> str:
    """Validate serial text against the built-in tiny engraving font."""
    normalized = text.strip().upper()
    if not normalized:
        raise ValueError("Serial text cannot be empty.")

    unsupported = sorted({character for character in normalized if character not in FONT_5X7})
    if unsupported:
        joined = ", ".join(unsupported)
        raise ValueError(f"Unsupported serial character(s): {joined}")

    if not re.fullmatch(r"[A-Z0-9 ._-]+", normalized):
        raise ValueError("Serial text can only contain A-Z, 0-9, space, period, dash, or underscore.")

    return normalized


def character_strokes(
    bitmap: tuple[str, ...],
    origin_x: float,
    origin_y: float,
    pixel_size: float,
    power: int,
    feed_mm_min: float,
    travel_feed_mm_min: float,
) -> list[str]:
    """Convert one 5x7 bitmap character into horizontal burn strokes."""
    lines: list[str] = []

    for row_index, row in enumerate(bitmap):
        y = origin_y - (row_index * pixel_size)
        column_index = 0

        while column_index < len(row):
            if row[column_index] != "1":
                column_index += 1
                continue

            start_column = column_index
            while column_index < len(row) and row[column_index] == "1":
                column_index += 1
            end_column = column_index - 1

            start_x = origin_x + (start_column * pixel_size)
            end_x = origin_x + ((end_column + 1) * pixel_size)
            lines.extend(
                [
                    f"G0 X{start_x:.3f} Y{y:.3f} F{travel_feed_mm_min:.1f}",
                    f"M4 S{power}",
                    f"G1 X{end_x:.3f} Y{y:.3f} F{feed_mm_min:.1f}",
                    "M5",
                ]
            )

    return lines


def write_gcode_file(lines: list[str], output_path: Path) -> Path:
    """Write generated G-code to disk."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return output_path


def stream_gcode_file(port: str, baud: int, gcode_path: Path) -> None:
    """Stream a G-code file to GRBL one line at a time."""
    try:
        import serial
    except ImportError as error:
        raise RuntimeError("Laser streaming requires pyserial. Install it with: pip install pyserial") from error

    with serial.Serial(port=port, baudrate=baud, timeout=2.0, write_timeout=2.0) as serial_port:
        time.sleep(2.0)
        read_available_lines(serial_port)

        for raw_line in gcode_path.read_text(encoding="utf-8").splitlines():
            command = raw_line.strip()
            if not command or command.startswith("("):
                continue

            serial_port.write(f"{command}\n".encode("ascii"))
            serial_port.flush()
            response = read_response_lines(serial_port)
            if any(line.startswith(("error", "ALARM")) for line in response):
                serial_port.write(b"M5\n")
                serial_port.flush()
                raise RuntimeError(f"GRBL rejected command {command!r}: {response}")


def read_response_lines(serial_port) -> list[str]:
    """Read a normal GRBL command response."""
    lines: list[str] = []
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        raw_line = serial_port.readline()
        if not raw_line:
            continue

        line = raw_line.decode("ascii", errors="replace").strip()
        if not line:
            continue

        lines.append(line)
        if line == "ok" or line.startswith(("error", "ALARM")):
            break

    return lines


def read_available_lines(serial_port) -> list[str]:
    """Drain startup/status text already waiting in the serial buffer."""
    lines: list[str] = []
    while serial_port.in_waiting:
        raw_line = serial_port.readline()
        if not raw_line:
            break
        line = raw_line.decode("ascii", errors="replace").strip()
        if line:
            lines.append(line)
    return lines
