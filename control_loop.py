from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Optional

from edukit_pa import EduKitConfig, EduKitPA, PlantSnapshot, clamp
from pid_controller import PIDConfig, PIDController


@dataclass
class ControlState:
    running: bool = False
    mode: str = "manual"
    manual_duty_percent: float = 0.0
    manual_pump_hold: bool = False
    manual_valve_hold: bool = False
    controller_output_percent: float = 0.0
    control_action: str = "idle"
    actual_pump_on: bool = False
    actual_drain_valve_on: bool = False
    error: Optional[str] = None
    sample_count: int = 0
    t_s: float = 0.0
    snapshot: Optional[PlantSnapshot] = None
    history: list[dict[str, float]] = field(default_factory=list)


class ControlLoop:
    def __init__(self, plant: EduKitPA, pid: PIDController, config: EduKitConfig) -> None:
        self.plant = plant
        self.pid = pid
        self.config = config
        self.state = ControlState()
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._start_time = time.monotonic()
        self._last_sample_time = self._start_time
        self._control_action: str = "idle"
        self._pause_until = 0.0
        self._valve_tap_until = 0.0

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self.state.running = True
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        self.plant.actuators_off()
        with self._lock:
            self.state.running = False
            self.state.manual_pump_hold = False
            self.state.manual_valve_hold = False
            self.state.actual_pump_on = False
            self.state.actual_drain_valve_on = False

    def set_mode(self, mode: str) -> None:
        if mode not in {"manual", "auto"}:
            raise ValueError("mode must be 'manual' or 'auto'")
        with self._lock:
            if self.state.mode != mode:
                self.pid.reset(self.state.controller_output_percent)
            if mode == "auto":
                self.state.manual_pump_hold = False
                self.state.manual_valve_hold = False
                self._control_action = "idle"
            self.state.mode = mode

    def set_manual_duty(self, duty_percent: float) -> None:
        with self._lock:
            self.state.manual_duty_percent = clamp(duty_percent, 0.0, self.config.manual_max_duty_percent)
            if self.state.manual_duty_percent > 0.0:
                self.state.manual_pump_hold = False
                self.state.manual_valve_hold = False

    def set_manual_actuator(self, actuator: str, enabled: bool) -> None:
        if actuator not in {"pump", "valve"}:
            raise ValueError("actuator must be 'pump' or 'valve'")
        with self._lock:
            self.state.mode = "manual"
            self.state.manual_duty_percent = 0.0
            if actuator == "pump":
                self.state.manual_pump_hold = enabled
                if enabled:
                    self.state.manual_valve_hold = False
            else:
                self.state.manual_valve_hold = enabled
                if enabled:
                    self.state.manual_pump_hold = False

    def set_pid_config(self, **values: float) -> None:
        with self._lock:
            for key, value in values.items():
                if hasattr(self.pid.config, key):
                    setattr(self.pid.config, key, float(value))
            self.pid.config.output_min = max(self.pid.config.output_min, -self.config.max_valve_percent)
            self.pid.config.output_max = min(self.pid.config.output_max, self.config.max_duty_percent)

    def set_control_config(self, **values: float) -> None:
        with self._lock:
            for key, value in values.items():
                if hasattr(self.config, key):
                    setattr(self.config, key, float(value))
            self.config.save()

    def get_state(self) -> dict[str, object]:
        with self._lock:
            snapshot = self.state.snapshot
            state = asdict(self.state)
            state["snapshot"] = asdict(snapshot) if snapshot else None
            state["pid"] = self.pid.config.as_dict()
            state["config"] = asdict(self.config)
            return state

    def _run(self) -> None:
        while not self._stop_event.is_set():
            now = time.monotonic()
            dt = now - self._last_sample_time
            self._last_sample_time = now

            try:
                snapshot = self.plant.read_snapshot()
                with self._lock:
                    mode = self.state.mode
                    manual_duty = self.state.manual_duty_percent
                    manual_pump_hold = self.state.manual_pump_hold
                    manual_valve_hold = self.state.manual_valve_hold

                if mode == "auto":
                    output = self._auto_output(snapshot, now)
                else:
                    if manual_valve_hold:
                        output = -self.config.max_valve_percent
                    elif manual_pump_hold:
                        output = self.config.manual_max_duty_percent
                    else:
                        output = manual_duty
                    self.pid.reset(output)
                    self._control_action = "idle"

                pump_on, drain_valve_on = self._apply_output(output, mode, now)

                with self._lock:
                    self.state.error = None
                    self.state.running = True
                    self.state.t_s = now - self._start_time
                    self.state.snapshot = snapshot
                    self.state.controller_output_percent = output
                    self.state.control_action = self._control_action
                    self.state.actual_pump_on = pump_on
                    self.state.actual_drain_valve_on = drain_valve_on
                    self.state.sample_count += 1
                    self._append_history_locked(now - self._start_time, snapshot, output)
            except Exception as exc:
                try:
                    self.plant.actuators_off()
                except Exception:
                    pass
                try:
                    self.plant.reconnect()
                except Exception:
                    pass
                with self._lock:
                    self.state.error = str(exc)
                    self.state.actual_pump_on = False
                    self.state.actual_drain_valve_on = False
                time.sleep(1.0)

            time.sleep(self.config.sample_time_s)

        self.plant.actuators_off()

    def _auto_output(self, snapshot: PlantSnapshot, now: float) -> float:
        error = self.pid.config.setpoint - snapshot.level_percent
        tolerance = max(0.0, self.config.level_tolerance_percent)
        pump_overfill_error = -(tolerance + max(0.0, self.config.pump_overfill_percent))
        valve_tap_error = -max(tolerance, self.config.valve_tap_band_percent)
        valve_fine_error = -max(tolerance, min(self.config.valve_fine_band_percent, self.config.valve_tap_band_percent))

        if self._control_action == "pump":
            if error <= pump_overfill_error:
                self._control_action = "idle"
                self._pause_until = now + max(0.0, self.config.actuator_pause_s)
                return 0.0
            return self.config.max_duty_percent

        if self._control_action == "valve_tap":
            if now >= self._valve_tap_until or error >= 0.0:
                self._control_action = "idle"
                self._pause_until = now + max(0.0, self.config.valve_tap_pause_s)
                return 0.0
            return -self.config.max_valve_percent

        if self._control_action == "valve_fine_tap":
            if now >= self._valve_tap_until or error >= 0.0:
                self._control_action = "idle"
                self._pause_until = now + max(0.0, self.config.valve_fine_tap_pause_s)
                return 0.0
            return -self.config.max_valve_percent

        if self._control_action == "valve_fast":
            if error >= valve_tap_error:
                self._control_action = "idle"
                self._pause_until = now + max(0.0, self.config.valve_tap_pause_s)
                return 0.0
            return -self.config.max_valve_percent

        if now < self._pause_until:
            return 0.0

        if error > tolerance:
            self._control_action = "pump"
            return self.config.max_duty_percent
        if error < -tolerance:
            if error < valve_tap_error:
                self._control_action = "valve_fast"
                return -self.config.max_valve_percent
            if error >= valve_fine_error:
                self._control_action = "valve_fine_tap"
                self._valve_tap_until = now + max(0.03, self.config.valve_fine_tap_s)
                return -self.config.max_valve_percent
            self._control_action = "valve_tap"
            self._valve_tap_until = now + max(0.05, self.config.valve_tap_s)
            return -self.config.max_valve_percent
        return 0.0

    def _apply_output(self, output_percent: float, mode: str, now: float) -> tuple[bool, bool]:
        if output_percent < -self.config.valve_deadband_percent:
            self.plant.set_pump_percent(0.0)
            self.plant.set_drain_valve(True)
            return False, True

        self.plant.set_drain_valve(False)
        pump_percent = max(0.0, output_percent)
        if pump_percent <= self.config.pump_deadband_percent:
            self.plant.set_pump_percent(0.0)
            return False, False

        if self.config.pump_mode == "analog":
            self.plant.set_pump_percent(pump_percent)
            return True, False

        self.plant.set_pump(True)
        return True, False

    def _append_history_locked(
        self,
        t_s: float,
        snapshot: PlantSnapshot,
        duty_percent: float,
    ) -> None:
        self.state.history.append(
            {
                "t": t_s,
                "level": snapshot.level_percent,
                "flow": snapshot.flow_percent,
                "pressure": snapshot.pressure_percent,
                "duty": duty_percent,
            }
        )
        if len(self.state.history) > 600:
            self.state.history = self.state.history[-600:]
