from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

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
    pump_command_percent: float = 0.0
    control_action: str = "idle"
    actual_pump_on: bool = False
    actual_drain_valve_on: bool = False
    error: Optional[str] = None
    sample_count: int = 0
    t_s: float = 0.0
    snapshot: Optional[PlantSnapshot] = None
    history: list[dict[str, float]] = field(default_factory=list)
    autotune: dict[str, object] = field(default_factory=dict)


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
        self._pump_hold_until = 0.0
        self._pump_was_commanded = False
        self._autotune_active = False
        self._autotune_start = 0.0
        self._autotune_last_side = 0
        self._autotune_crossings: list[float] = []
        self._autotune_peaks: list[float] = []
        self._autotune_troughs: list[float] = []
        self._autotune_high = 0.0
        self._autotune_phase = "idle"
        self._autotune_phase_start = 0.0
        self._autotune_curve_index = 0
        self._autotune_curve_outputs: list[float] = []
        self._autotune_curve_points: list[dict[str, float]] = []
        self._autotune_response: list[dict[str, float]] = []
        self._autotune_step_start = 0.0
        self._autotune_step_level = 0.0

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
            self.state.pump_command_percent = 0.0

    def start_autotune(self) -> None:
        with self._lock:
            self.state.mode = "auto"
            self.state.manual_pump_hold = False
            self.state.manual_valve_hold = False
            self._autotune_active = True
            self._autotune_start = time.monotonic()
            self._autotune_last_side = 0
            self._autotune_crossings = []
            self._autotune_peaks = []
            self._autotune_troughs = []
            step = max(1.0, self.config.autotune_curve_step_percent)
            self._autotune_curve_outputs = []
            value = 0.0
            while value <= self.config.max_duty_percent + 0.001:
                self._autotune_curve_outputs.append(round(value, 3))
                value += step
            if self.config.max_duty_percent not in self._autotune_curve_outputs:
                self._autotune_curve_outputs.append(self.config.max_duty_percent)
            self._autotune_curve_index = 0
            self._autotune_curve_points = []
            self._autotune_response = []
            self._autotune_phase = "curve"
            self._autotune_phase_start = self._autotune_start
            self._autotune_high = self.config.max_duty_percent
            self._autotune_step_start = 0.0
            self._autotune_step_level = 0.0
            self._control_action = "autotune"
            self.pid.reset(0.0)
            self.state.autotune = {
                "running": True,
                "status": "started",
                "phase": "curve",
                "message": "Kennlinie Stellgroesse zu Durchfluss",
                "output_percent": 0.0,
                "curve": [],
                "response": [],
            }

    def stop_autotune(self) -> None:
        with self._lock:
            self._autotune_active = False
            self._autotune_phase = "idle"
            self._control_action = "idle"
            self.state.autotune = {
                **self.state.autotune,
                "running": False,
                "status": "stopped",
                "message": "Autotune gestoppt",
            }
        self.plant.actuators_off()

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

    def set_control_config(self, **values: Any) -> None:
        requested_pump_mode: Optional[str] = None
        with self._lock:
            for key, value in values.items():
                if hasattr(self.config, key):
                    if key == "control_strategy":
                        strategy = str(value)
                        if strategy not in {"three_point", "pid"}:
                            raise ValueError("control_strategy must be 'three_point' or 'pid'")
                        if strategy != self.config.control_strategy:
                            self.pid.reset(self.state.controller_output_percent)
                            self._control_action = "idle"
                            self._pause_until = 0.0
                            self._valve_tap_until = 0.0
                            self._pump_hold_until = 0.0
                            self._pump_was_commanded = False
                        setattr(self.config, key, strategy)
                        requested_pump_mode = "analog" if strategy == "pid" else self.config.three_point_pump_mode
                    elif key == "three_point_pump_mode":
                        mode = str(value)
                        if mode not in {"analog", "digital_pwm"}:
                            raise ValueError("three_point_pump_mode must be 'analog' or 'digital_pwm'")
                        setattr(self.config, key, mode)
                        if self.config.control_strategy == "three_point":
                            requested_pump_mode = mode
                    else:
                        setattr(self.config, key, float(value))
            self.config.save()
            self.pid.config.output_max = min(self.pid.config.output_max, self.config.max_duty_percent)
            self.pid.config.output_min = max(self.pid.config.output_min, -self.config.max_valve_percent)
        if requested_pump_mode:
            try:
                self.plant.prepare_pump_mode(requested_pump_mode)
            except Exception:
                with self._lock:
                    self.state.error = f"Pump mode switch to {requested_pump_mode} failed"
                raise

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

                if self._autotune_active:
                    output = self._autotune_output(snapshot, now)
                elif mode == "auto":
                    output = self._auto_output(snapshot, now, dt)
                else:
                    if manual_valve_hold:
                        output = -self.config.max_valve_percent
                    elif manual_pump_hold:
                        output = self.config.manual_max_duty_percent
                    else:
                        output = manual_duty
                    self.pid.reset(output)
                    self._control_action = "idle"

                pump_on, drain_valve_on, pump_command = self._apply_output(output, mode, now, snapshot)

                with self._lock:
                    self.state.error = None
                    self.state.running = True
                    self.state.t_s = now - self._start_time
                    self.state.snapshot = snapshot
                    self.state.controller_output_percent = output
                    self.state.pump_command_percent = pump_command
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
                    self.state.pump_command_percent = 0.0
                time.sleep(1.0)

            time.sleep(self.config.sample_time_s)

        self.plant.actuators_off()

    def _autotune_output(self, snapshot: PlantSnapshot, now: float) -> float:
        elapsed = now - self._autotune_start
        if elapsed > self.config.autotune_max_duration_s:
            self._finish_autotune("timeout")
            return 0.0

        self._control_action = "autotune"
        if self._autotune_phase == "curve":
            output = self._autotune_curve_outputs[self._autotune_curve_index]
            if now - self._autotune_phase_start >= self.config.autotune_curve_hold_s:
                self._autotune_curve_points.append(
                    {
                        "output": output,
                        "flow": snapshot.flow_percent,
                        "level": snapshot.level_percent,
                    }
                )
                self._autotune_curve_index += 1
                self._autotune_phase_start = now
                if self._autotune_curve_index >= len(self._autotune_curve_outputs):
                    self._autotune_phase = "empty"
                    self._autotune_phase_start = now
                    output = 0.0
                else:
                    output = self._autotune_curve_outputs[self._autotune_curve_index]
            self._publish_autotune(
                elapsed,
                "Kennlinie Stellgroesse zu Durchfluss",
                output,
                phase="curve",
            )
            return output

        if self._autotune_phase == "empty":
            if snapshot.level_percent <= self.config.autotune_start_level_percent:
                self._autotune_phase = "settle"
                self._autotune_phase_start = now
                self._publish_autotune(elapsed, "Startlevel erreicht, beruhige kurz", 0.0, phase="settle")
                return 0.0
            self._publish_autotune(elapsed, "Entleere bis Startlevel", 0.0, phase="empty")
            return -self.config.max_valve_percent

        if self._autotune_phase == "settle":
            if now - self._autotune_phase_start >= 2.0:
                self._autotune_phase = "step"
                self._autotune_phase_start = now
                self._autotune_step_start = now
                self._autotune_step_level = snapshot.level_percent
                self._autotune_response = []
            self._publish_autotune(elapsed, "Bereite Vollgas-Sprungantwort vor", 0.0, phase="settle")
            return 0.0

        if self._autotune_phase == "step":
            t = now - self._autotune_step_start
            self._autotune_response.append(
                {
                    "t": t,
                    "level": snapshot.level_percent,
                    "flow": snapshot.flow_percent,
                    "output": self.config.max_duty_percent,
                }
            )
            if snapshot.level_percent >= self.config.autotune_end_level_percent:
                self._finish_reaction_curve()
                return 0.0
            self._publish_autotune(elapsed, "Vollgas-Sprungantwort laeuft", self.config.max_duty_percent, phase="step")
            return self.config.max_duty_percent

        self._publish_autotune(elapsed, "Autotune wartet", 0.0, phase=self._autotune_phase)
        return 0.0

    def _publish_autotune(self, elapsed: float, message: str, output: float, *, phase: str) -> None:
        threshold = next(
            (
                point["output"]
                for point in self._autotune_curve_points
                if point["flow"] >= self.config.flow_start_threshold_percent
            ),
            None,
        )
        with self._lock:
            self.state.autotune = {
                "running": True,
                "status": "running",
                "phase": phase,
                "message": message,
                "elapsed_s": elapsed,
                "output_percent": output,
                "curve": self._autotune_curve_points[-20:],
                "response": self._autotune_response[-120:],
                "flow_threshold_output": threshold,
                "start_level_percent": self.config.autotune_start_level_percent,
                "end_level_percent": self.config.autotune_end_level_percent,
            }

    def _finish_reaction_curve(self) -> None:
        self._autotune_active = False
        self._autotune_phase = "done"
        samples = self._autotune_response
        if len(samples) < 5:
            self._finish_autotune("failed")
            return

        start_level = self._autotune_step_level
        noise = max(0.2, self.config.autotune_level_noise_percent)
        deadtime = next((point["t"] for point in samples if point["level"] >= start_level + noise), samples[0]["t"])
        slopes = [
            (samples[index]["level"] - samples[index - 1]["level"]) / max(0.001, samples[index]["t"] - samples[index - 1]["t"])
            for index in range(1, len(samples))
        ]
        max_slope = max(slopes) if slopes else 0.0
        if max_slope <= 0.001:
            self._finish_autotune("failed")
            return

        process_deadtime = max(0.2, deadtime)
        kp = 1.2 * self.config.max_duty_percent / (max_slope * process_deadtime)
        ti = 2.0 * process_deadtime
        td = 0.5 * process_deadtime
        self.pid.config.kp = clamp(kp, 0.0, 20.0)
        self.pid.config.ki = clamp(self.pid.config.kp / ti, 0.0, 2.0)
        self.pid.config.kd = clamp(self.pid.config.kp * td, 0.0, 20.0)
        threshold = next(
            (
                point["output"]
                for point in self._autotune_curve_points
                if point["flow"] >= self.config.flow_start_threshold_percent
            ),
            self.config.min_pump_effective_percent,
        )
        if threshold is not None:
            self.config.min_pump_effective_percent = clamp(float(threshold), 0.0, 90.0)
        self.config.min_pump_on_s = clamp(process_deadtime, 0.5, 20.0)
        self.config.save()
        self.pid.reset(0.0)
        with self._lock:
            self.state.autotune = {
                "running": False,
                "status": "done",
                "phase": "done",
                "message": "Kennlinie und Sprungantwort ausgewertet",
                "curve": self._autotune_curve_points,
                "response": self._autotune_response[-120:],
                "flow_threshold_output": threshold,
                "deadtime_s": process_deadtime,
                "max_slope_percent_s": max_slope,
                "kp": self.pid.config.kp,
                "ki": self.pid.config.ki,
                "kd": self.pid.config.kd,
            }

    def _finish_autotune(self, status: str) -> bool:
        self._autotune_active = False
        self._autotune_phase = status
        if status != "done" or len(self._autotune_crossings) < 6:
            with self._lock:
                self.state.autotune = {
                    "running": False,
                    "status": status,
                    "message": "Autotune ohne gueltige Sprungantwort beendet",
                    "phase": status,
                    "curve": self._autotune_curve_points,
                    "response": self._autotune_response[-120:],
                }
            return False

        periods = [
            self._autotune_crossings[index] - self._autotune_crossings[index - 2]
            for index in range(2, len(self._autotune_crossings))
        ]
        amplitudes = [
            abs(peak - trough) / 2.0
            for peak, trough in zip(self._autotune_peaks[-3:], self._autotune_troughs[-3:])
        ]
        tu = sum(periods[-3:]) / max(1, len(periods[-3:]))
        amplitude = max(0.1, sum(amplitudes) / max(1, len(amplitudes)))
        relay = max(1.0, self._autotune_high)
        ku = 4.0 * relay / (3.14159 * amplitude)
        kp = 0.6 * ku
        ki = kp / (0.5 * tu) if tu > 0 else 0.0
        kd = kp * (0.125 * tu)
        self.pid.config.kp = clamp(kp, 0.0, 20.0)
        self.pid.config.ki = clamp(ki, 0.0, 2.0)
        self.pid.config.kd = clamp(kd, 0.0, 20.0)
        self.pid.reset(0.0)
        with self._lock:
            self.state.autotune = {
                "running": False,
                "status": "done",
                "message": "Ziegler-Nichols Werte uebernommen",
                "ku": ku,
                "tu_s": tu,
                "amplitude_percent": amplitude,
                "kp": self.pid.config.kp,
                "ki": self.pid.config.ki,
                "kd": self.pid.config.kd,
            }
        return True

    def _auto_output(self, snapshot: PlantSnapshot, now: float, dt: float) -> float:
        if self.config.control_strategy == "pid" and self.config.pump_mode != "analog":
            self.config.pump_mode = "analog"
        if self.config.control_strategy == "pid" and self.config.pump_mode == "analog":
            error = self.pid.config.setpoint - snapshot.level_percent
            tolerance = max(0.0, self.config.level_tolerance_percent)
            if abs(error) <= tolerance:
                self.pid.reset(0.0)
                self._control_action = "pid_hold"
                return 0.0
            self._control_action = "pid"
            return self.pid.update(snapshot.level_percent, dt)

        self.pid.reset(self.state.controller_output_percent)
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

    def _apply_output(
        self,
        output_percent: float,
        mode: str,
        now: float,
        snapshot: PlantSnapshot,
    ) -> tuple[bool, bool, float]:
        if output_percent < -self.config.valve_deadband_percent:
            self._pump_hold_until = 0.0
            self._pump_was_commanded = False
            self.plant.set_pump_percent(0.0)
            self.plant.set_drain_valve(True)
            return False, True, 0.0

        self.plant.set_drain_valve(False)
        pump_percent = max(0.0, output_percent)
        if pump_percent <= self.config.pump_deadband_percent:
            if self._should_hold_pump_after_start(now, snapshot, mode):
                pump_percent = max(self.config.min_pump_effective_percent, self.config.pump_deadband_percent + 0.1)
            else:
                self._pump_was_commanded = False
                self.plant.set_pump_percent(0.0)
                return False, False, 0.0
        else:
            if mode == "auto" and not self._autotune_active and not self._pump_was_commanded:
                self._pump_hold_until = now + max(0.0, self.config.min_pump_on_s)
            self._pump_was_commanded = True

        if not self._autotune_active and 0.0 < pump_percent < self.config.min_pump_effective_percent:
            pump_percent = self.config.min_pump_effective_percent

        flow_target = max(0.0, self.config.min_flow_percent)
        if not self._autotune_active and flow_target > 0.0 and snapshot.flow_percent < flow_target:
            flow_error = flow_target - snapshot.flow_percent
            boosted = self.config.min_pump_effective_percent + flow_error * self.config.flow_boost_gain
            pump_percent = max(pump_percent, boosted)
        pump_percent = clamp(pump_percent, 0.0, self.config.max_duty_percent)

        if self.config.pump_mode == "analog":
            self.plant.set_pump_percent(pump_percent)
            return True, False, pump_percent

        self.plant.set_pump(True)
        return True, False, 100.0

    def _should_hold_pump_after_start(self, now: float, snapshot: PlantSnapshot, mode: str) -> bool:
        if mode != "auto" or self._autotune_active:
            return False
        if not self._pump_was_commanded or now >= self._pump_hold_until:
            return False
        if snapshot.level_high_switch:
            return False
        upper_limit = self.pid.config.setpoint + max(0.0, self.config.level_tolerance_percent)
        return snapshot.level_percent < upper_limit

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
