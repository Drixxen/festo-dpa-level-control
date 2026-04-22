from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional


@dataclass
class PIDConfig:
    kp: float = 2.0
    ki: float = 0.05
    kd: float = 0.0
    setpoint: float = 50.0
    output_min: float = 0.0
    output_max: float = 100.0
    derivative_filter: float = 0.2

    def as_dict(self) -> dict[str, float]:
        return asdict(self)


class PIDController:
    """PID controller with clamping anti-windup and derivative-on-measurement."""

    def __init__(self, config: PIDConfig) -> None:
        self.config = config
        self.integral = 0.0
        self.previous_measurement: Optional[float] = None
        self.filtered_derivative = 0.0
        self.last_output = 0.0

    def reset(self, output: float = 0.0) -> None:
        self.integral = 0.0
        self.previous_measurement = None
        self.filtered_derivative = 0.0
        self.last_output = output

    def update(self, measurement: float, dt: float) -> float:
        if dt <= 0:
            return self.last_output

        error = self.config.setpoint - measurement

        derivative = 0.0
        if self.previous_measurement is not None:
            derivative = -(measurement - self.previous_measurement) / dt
        self.previous_measurement = measurement

        alpha = max(0.0, min(1.0, self.config.derivative_filter))
        self.filtered_derivative = (
            alpha * derivative + (1.0 - alpha) * self.filtered_derivative
        )

        candidate_integral = self.integral + error * dt
        output = (
            self.config.kp * error
            + self.config.ki * candidate_integral
            + self.config.kd * self.filtered_derivative
        )

        clamped = max(self.config.output_min, min(self.config.output_max, output))
        if output == clamped or _would_reduce_saturation(error, output, clamped):
            self.integral = candidate_integral

        self.last_output = clamped
        return clamped


def _would_reduce_saturation(error: float, output: float, clamped: float) -> bool:
    if output > clamped:
        return error < 0
    if output < clamped:
        return error > 0
    return True
