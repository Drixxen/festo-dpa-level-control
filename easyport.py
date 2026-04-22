from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

import serial
from serial.tools import list_ports


DEFAULT_BAUDRATE = 115_200
DEFAULT_TIMEOUT = 0.5
DEFAULT_WRITE_TIMEOUT = 0.5


class EasyPortError(RuntimeError):
    """Raised when the EasyPort returns an invalid or unexpected response."""


@dataclass(frozen=True)
class PortCandidate:
    device: str
    description: str
    hwid: str
    likely: bool


def list_serial_ports() -> list[PortCandidate]:
    """Return serial ports, marking USB serial adapters as likely candidates."""
    candidates: list[PortCandidate] = []
    likely_markers = (
        "usb",
        "serial",
        "ftdi",
        "prolific",
        "pl2303",
        "wch",
        "ch340",
        "cp210",
        "silicon labs",
    )

    for port in list_ports.comports():
        text = f"{port.device} {port.description} {port.hwid}".lower()
        candidates.append(
            PortCandidate(
                device=port.device,
                description=port.description,
                hwid=port.hwid,
                likely=any(marker in text for marker in likely_markers),
            )
        )

    return candidates


def guess_port() -> Optional[str]:
    """Pick the first likely macOS callout port, falling back to any serial port."""
    ports = list_serial_ports()

    for port in ports:
        if port.device.startswith("/dev/cu.") and port.likely:
            return port.device

    for port in ports:
        if port.device.startswith("/dev/cu."):
            return port.device

    return ports[0].device if ports else None


class EasyPort:
    """Small wrapper around the Festo EasyPort ASCII command interpreter.

    Commands are sent as ASCII and terminated with carriage return (CR).
    The module returns hexadecimal values for signal data.
    """

    def __init__(
        self,
        port: Optional[str] = None,
        *,
        address: int = 1,
        baudrate: int = DEFAULT_BAUDRATE,
        timeout: float = DEFAULT_TIMEOUT,
        write_timeout: float = DEFAULT_WRITE_TIMEOUT,
    ) -> None:
        if not 1 <= address <= 4:
            raise ValueError("EasyPort module address must be in range 1..4")

        self.port = port or guess_port()
        if self.port is None:
            raise EasyPortError("No serial port found. Is the USB-RS232 adapter visible to macOS?")

        self.address = address
        self._serial = serial.Serial(
            port=self.port,
            baudrate=baudrate,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=timeout,
            write_timeout=write_timeout,
        )

    def close(self) -> None:
        self._serial.close()

    def __enter__(self) -> "EasyPort":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def command(self, command: str) -> str:
        """Send a raw command without CR and return one response line without CR/LF."""
        responses = self.command_lines(command, max_lines=1)
        return responses[0]

    def command_lines(
        self,
        command: str,
        *,
        max_lines: int = 8,
        stop_on_assignment: bool = False,
    ) -> list[str]:
        """Send a raw command and return all response lines received before timeout.

        Some USB/RS232 setups echo the transmitted command before the EasyPort answer.
        Returning multiple lines lets higher-level helpers ignore those echoes.
        """
        clean = command.strip()
        if not clean:
            raise ValueError("Command must not be empty")

        self._serial.reset_input_buffer()
        self._serial.write(clean.encode("ascii") + b"\r")
        self._serial.flush()

        responses: list[str] = []
        for _ in range(max_lines):
            response = self._serial.read_until(b"\r")
            if not response:
                break
            decoded = response.decode("ascii", errors="replace").strip("\r\n")
            if decoded:
                responses.append(decoded)
                if stop_on_assignment and _looks_like_assignment(decoded):
                    break

        if not responses:
            raise EasyPortError(f"Timeout waiting for response to {clean!r}")

        return responses

    def identify(self) -> str:
        """Try the simple ID command used by many EasyPort examples."""
        return self.command("ID")

    def display(self, resource: str) -> str:
        """Display/read a resource, for example AW1.0 or EW1.0."""
        return self._first_assignment(f"D{resource}", resource)

    def modify(self, resource: str, value: int, *, width: int = 4) -> str:
        """Modify/write a resource using hexadecimal EasyPort values."""
        if value < 0:
            raise ValueError("EasyPort values must be non-negative")
        return self._first_assignment(f"M{resource}={value:0{width}X}", resource)

    def _first_assignment(self, command: str, resource: str) -> str:
        responses = self.command_lines(command, stop_on_assignment=True)
        for response in responses:
            if _is_assignment_for(response, resource):
                return response
        raise EasyPortError(
            f"No assignment response for {command!r}; got: {', '.join(repr(r) for r in responses)}"
        )

    def read_word(self, resource: str) -> int:
        """Read a word resource and parse the returned hexadecimal value."""
        response = self.display(resource)
        return _parse_hex_assignment(response, expected_resource=resource)

    def write_word(self, resource: str, value: int) -> int:
        """Write a word resource and return the echoed hexadecimal value."""
        response = self.modify(resource, value, width=4)
        return _parse_hex_assignment(response, expected_resource=resource)

    def read_analog_input_raw(self, channel: int) -> int:
        return self.read_word(f"EW{self.address}.{_analog_input_offset(channel)}")

    def read_analog_output_raw(self, channel: int) -> int:
        return self.read_word(f"AW{self.address}.{_analog_output_offset(channel)}")

    def write_analog_output_raw(self, channel: int, value: int) -> int:
        if not 0 <= value <= 0x7FF8:
            raise ValueError("Analogue output raw value must be in range 0x0000..0x7FF8")
        return self.write_word(f"AW{self.address}.{_analog_output_offset(channel)}", value)

    def read_digital_inputs_word(self) -> int:
        return self.read_word(f"EW{self.address}.0")

    def read_digital_outputs_word(self) -> int:
        return self.read_word(f"AW{self.address}.0")

    def write_digital_outputs_word(self, value: int) -> int:
        if not 0 <= value <= 0xFFFF:
            raise ValueError("Digital output word must be in range 0x0000..0xFFFF")
        return self.write_word(f"AW{self.address}.0", value)

    def set_digital_output(self, bit: int, enabled: bool) -> int:
        if not 0 <= bit <= 15:
            raise ValueError("Digital output bit must be in range 0..15")
        current = self.read_digital_outputs_word()
        mask = 1 << bit
        next_value = (current | mask) if enabled else (current & ~mask)
        return self.write_digital_outputs_word(next_value)

    def stop_outputs(self) -> int:
        """Convenience helper for switching all digital outputs off."""
        return self.write_digital_outputs_word(0)


def raw_to_voltage(raw: int, *, full_scale: float = 10.0) -> float:
    """Convert EasyPort 0x0000..0x7FF8 raw analogue value to voltage."""
    return (raw / 0x7FF8) * full_scale


def voltage_to_raw(voltage: float, *, full_scale: float = 10.0) -> int:
    """Convert voltage to EasyPort raw analogue value, clamped to the valid range."""
    clamped = max(0.0, min(full_scale, voltage))
    return round((clamped / full_scale) * 0x7FF8)


def _parse_hex_assignment(response: str, *, expected_resource: Optional[str] = None) -> int:
    if "=" not in response:
        raise EasyPortError(f"Response has no assignment: {response!r}")

    resource, value = response.split("=", 1)
    if expected_resource is not None and not _resource_matches(resource, expected_resource):
        raise EasyPortError(
            f"Unexpected resource in response: got {resource!r}, expected {expected_resource!r}"
        )

    try:
        return int(value, 16)
    except ValueError as exc:
        raise EasyPortError(f"Response value is not hexadecimal: {response!r}") from exc


def _is_assignment_for(response: str, expected_resource: str) -> bool:
    if "=" not in response:
        return False
    resource, value = response.split("=", 1)
    if not resource.strip() or not value.strip():
        return False
    return _resource_matches(resource, expected_resource)


def _looks_like_assignment(response: str) -> bool:
    if "=" not in response:
        return False
    resource, value = response.split("=", 1)
    return bool(resource.strip()) and bool(value.strip())


def _analog_input_offset(channel: int) -> int:
    if not 0 <= channel <= 3:
        raise ValueError("Analogue input channel must be in range 0..3")
    return channel * 2


def _resource_matches(resource: str, expected_resource: str) -> bool:
    actual = resource.upper()
    expected = expected_resource.upper()
    return actual == expected or actual.endswith(expected)


def _analog_output_offset(channel: int) -> int:
    if not 0 <= channel <= 1:
        raise ValueError("Analogue output channel must be in range 0..1")
    return channel * 2 + 2


def format_ports(ports: Iterable[PortCandidate]) -> str:
    lines = []
    for port in ports:
        marker = "*" if port.likely else " "
        lines.append(f"{marker} {port.device:28} {port.description} [{port.hwid}]")
    return "\n".join(lines)
