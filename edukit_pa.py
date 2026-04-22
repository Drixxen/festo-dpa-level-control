from __future__ import annotations

import json
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Deque, Optional, Union

from easyport import EasyPort, raw_to_voltage


@dataclass
class EduKitConfig:
    port: str = "/dev/cu.usbserial-AC00K3IP"
    address: int = 1
    pump_mode: str = "digital_pwm"
    pump_bit: int = 3
    pump_analog_channel: int = 0
    drain_valve_bit: int = 0
    level_channel: int = 1
    flow_channel: int = 2
    pressure_channel: int = 3
    level_low_bit: int = 3
    level_high_bit: int = 4
    level_empty_raw: int = 0
    level_full_raw: int = 0x7FF8
    flow_zero_raw: int = 0
    flow_max_raw: int = 0x7FF8
    pressure_zero_raw: int = 0
    pressure_max_raw: int = 0x7FF8
    sample_time_s: float = 0.2
    pwm_period_s: float = 2.0
    min_pump_on_s: float = 2.0
    max_duty_percent: float = 100.0
    max_valve_percent: float = 100.0
    manual_max_duty_percent: float = 100.0
    pump_deadband_percent: float = 1.0
    valve_deadband_percent: float = 1.0
    level_tolerance_percent: float = 3.0
    pump_overfill_percent: float = 2.5
    valve_tap_band_percent: float = 5.0
    valve_tap_s: float = 0.4
    valve_tap_pause_s: float = 1.8
    valve_fine_band_percent: float = 2.0
    valve_fine_tap_s: float = 0.15
    valve_fine_tap_pause_s: float = 1.2
    actuator_pause_s: float = 1.5
    analog_filter_alpha: float = 1.0
    analog_filter_samples: int = 1
    analog_filter_window_s: float = 1.0
    analog_outlier_raw: int = 180
    analog_outlier_confirm: int = 2

    @classmethod
    def load(cls, path: Union[str, Path] = "edukit_config.json") -> "EduKitConfig":
        config_path = Path(path)
        if not config_path.exists():
            return cls()
        data = json.loads(config_path.read_text())
        return cls(**{**asdict(cls()), **data})

    def save(self, path: Union[str, Path] = "edukit_config.json") -> None:
        Path(path).write_text(json.dumps(asdict(self), indent=2) + "\n")


@dataclass
class PlantSnapshot:
    level_raw: int
    flow_raw: int
    pressure_raw: int
    level_percent: float
    flow_percent: float
    pressure_percent: float
    level_voltage: float
    flow_voltage: float
    pressure_voltage: float
    digital_inputs: int
    digital_outputs: int
    analog_output_raw: int
    level_low_switch: bool
    level_high_switch: bool
    pump_on: bool
    drain_valve_on: bool


class EduKitPA:
    """Process-oriented wrapper for the Festo EduKit PA EasyPort wiring."""

    def __init__(self, config: EduKitConfig, easyport: Optional[EasyPort] = None) -> None:
        self.config = config
        self.easyport = easyport or EasyPort(config.port, address=config.address)
        self._io_lock = threading.RLock()
        self._filtered_raw: dict[str, float] = {}
        self._outlier_counts: dict[str, int] = {}
        self._raw_windows: dict[str, Deque[tuple[float, int]]] = {}

    def close(self) -> None:
        with self._io_lock:
            self.actuators_off()
            self.easyport.close()

    def reconnect(self) -> None:
        with self._io_lock:
            try:
                self.easyport.close()
            except Exception:
                pass
            self.easyport = EasyPort(self.config.port, address=self.config.address)

    def __enter__(self) -> "EduKitPA":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def read_snapshot(self) -> PlantSnapshot:
        with self._io_lock:
            level_raw = self._read_filtered_analog("level", self.config.level_channel)
            flow_raw = self._read_filtered_analog("flow", self.config.flow_channel)
            pressure_raw = self._read_filtered_analog("pressure", self.config.pressure_channel)
            digital_inputs = self.easyport.read_digital_inputs_word()
            digital_outputs = self.easyport.read_digital_outputs_word()
            analog_output_raw = self.easyport.read_analog_output_raw(self.config.pump_analog_channel)

        return PlantSnapshot(
            level_raw=level_raw,
            flow_raw=flow_raw,
            pressure_raw=pressure_raw,
            level_percent=scale_raw(
                level_raw,
                self.config.level_empty_raw,
                self.config.level_full_raw,
                clamp_result=False,
            ),
            flow_percent=scale_raw(flow_raw, self.config.flow_zero_raw, self.config.flow_max_raw),
            pressure_percent=scale_raw(
                pressure_raw,
                self.config.pressure_zero_raw,
                self.config.pressure_max_raw,
            ),
            level_voltage=raw_to_voltage(level_raw),
            flow_voltage=raw_to_voltage(flow_raw),
            pressure_voltage=raw_to_voltage(pressure_raw),
            digital_inputs=digital_inputs,
            digital_outputs=digital_outputs,
            analog_output_raw=analog_output_raw,
            level_low_switch=bool(digital_inputs & (1 << self.config.level_low_bit)),
            level_high_switch=bool(digital_inputs & (1 << self.config.level_high_bit)),
            pump_on=self._pump_feedback(digital_outputs, analog_output_raw),
            drain_valve_on=self._digital_output_feedback(digital_outputs, self.config.drain_valve_bit),
        )

    def set_pump(self, enabled: bool) -> None:
        with self._io_lock:
            if self.config.pump_mode == "analog":
                self.set_pump_percent(100.0 if enabled else 0.0)
                return
            self.easyport.set_digital_output(self.config.pump_bit, enabled)

    def set_drain_valve(self, enabled: bool) -> None:
        with self._io_lock:
            self.easyport.set_digital_output(self.config.drain_valve_bit, enabled)

    def _read_filtered_analog(self, key: str, channel: int) -> int:
        sample_count = max(1, int(self.config.analog_filter_samples))
        if sample_count == 1:
            raw = self.easyport.read_analog_input_raw(channel)
        else:
            samples = sorted(self.easyport.read_analog_input_raw(channel) for _ in range(sample_count))
            raw = samples[len(samples) // 2]
        raw = self._windowed_raw_average(key, raw)
        previous = self._filtered_raw.get(key)
        if previous is None:
            filtered = float(raw)
        elif abs(raw - previous) > self.config.analog_outlier_raw:
            count = self._outlier_counts.get(key, 0) + 1
            self._outlier_counts[key] = count
            if count < self.config.analog_outlier_confirm:
                filtered = previous
            else:
                filtered = previous + clamp(self.config.analog_filter_alpha, 0.0, 1.0) * (raw - previous)
        else:
            self._outlier_counts[key] = 0
            alpha = clamp(self.config.analog_filter_alpha, 0.0, 1.0)
            filtered = previous + alpha * (raw - previous)
        self._filtered_raw[key] = filtered
        return round(filtered)

    def _windowed_raw_average(self, key: str, raw: int) -> int:
        now = time.monotonic()
        window_s = max(0.0, float(self.config.analog_filter_window_s))
        if window_s <= 0.0:
            return raw

        window = self._raw_windows.setdefault(key, deque())
        window.append((now, raw))
        while window and now - window[0][0] > window_s:
            window.popleft()

        values = [value for _, value in window]
        if len(values) < 3:
            return round(sum(values) / len(values))

        sorted_values = sorted(values)
        median = sorted_values[len(sorted_values) // 2]
        outlier_limit = max(0, int(self.config.analog_outlier_raw))
        clean_values = [value for value in values if abs(value - median) <= outlier_limit]
        if not clean_values:
            clean_values = values
        return round(sum(clean_values) / len(clean_values))

    def set_pump_percent(self, percent: float) -> None:
        with self._io_lock:
            value = clamp(percent, 0.0, 100.0)
            if self.config.pump_mode == "analog":
                raw = round(value / 100.0 * 0x7FF8)
                self.easyport.write_analog_output_raw(self.config.pump_analog_channel, raw)
                return
            self.set_pump(value > 0.0)

    def pump_on(self) -> None:
        self.set_pump(True)

    def pump_off(self) -> None:
        self.set_pump(False)

    def actuators_off(self) -> None:
        with self._io_lock:
            self.set_pump_percent(0.0)
            self.set_drain_valve(False)

    def _pump_feedback(self, digital_outputs: int, analog_output_raw: int) -> bool:
        if self.config.pump_mode == "analog":
            return analog_output_raw > 0
        return self._digital_output_feedback(digital_outputs, self.config.pump_bit)

    @staticmethod
    def _digital_output_feedback(digital_outputs: int, bit: int) -> bool:
        return bool(digital_outputs & (1 << bit))


def scale_raw(raw: int, low_raw: int, high_raw: int, *, clamp_result: bool = True) -> float:
    if high_raw == low_raw:
        return 0.0
    value = (raw - low_raw) / (high_raw - low_raw) * 100.0
    if not clamp_result:
        return value
    return clamp(value, 0.0, 100.0)


def unscale_percent(percent: float, low_raw: int, high_raw: int) -> int:
    return round(low_raw + clamp(percent, 0.0, 100.0) / 100.0 * (high_raw - low_raw))


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))
