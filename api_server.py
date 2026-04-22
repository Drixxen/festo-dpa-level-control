from __future__ import annotations

import argparse
import json
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from control_loop import ControlLoop
from edukit_pa import EduKitConfig, EduKitPA
from pid_controller import PIDConfig, PIDController


class ApiHandler(BaseHTTPRequestHandler):
    loop: ControlLoop

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_common_headers("text/plain", 0)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/state":
            self._send_json(self.loop.get_state())
            return
        self._send(404, b"Not found", "text/plain")

    def do_POST(self) -> None:
        body = self._read_json()
        try:
            if self.path == "/api/mode":
                self.loop.set_mode(str(body.get("mode", "manual")))
                self._send_json({"ok": True})
                return
            if self.path == "/api/manual":
                self.loop.set_manual_duty(float(body.get("duty", 0.0)))
                self._send_json({"ok": True})
                return
            if self.path == "/api/actuator":
                self.loop.set_manual_actuator(
                    str(body.get("actuator", "")),
                    bool(body.get("enabled", False)),
                )
                self._send_json({"ok": True})
                return
            if self.path == "/api/pid":
                self.loop.set_pid_config(
                    kp=float(body.get("kp", self.loop.pid.config.kp)),
                    ki=float(body.get("ki", self.loop.pid.config.ki)),
                    kd=float(body.get("kd", self.loop.pid.config.kd)),
                    setpoint=float(body.get("setpoint", self.loop.pid.config.setpoint)),
                )
                self._send_json({"ok": True})
                return
            if self.path == "/api/config":
                self.loop.set_control_config(
                    level_tolerance_percent=float(
                        body.get("level_tolerance_percent", self.loop.config.level_tolerance_percent)
                    ),
                    pump_overfill_percent=float(
                        body.get("pump_overfill_percent", self.loop.config.pump_overfill_percent)
                    ),
                    valve_tap_band_percent=float(
                        body.get("valve_tap_band_percent", self.loop.config.valve_tap_band_percent)
                    ),
                    valve_tap_s=float(
                        body.get("valve_tap_s", self.loop.config.valve_tap_s)
                    ),
                    valve_tap_pause_s=float(
                        body.get("valve_tap_pause_s", self.loop.config.valve_tap_pause_s)
                    ),
                    valve_fine_band_percent=float(
                        body.get("valve_fine_band_percent", self.loop.config.valve_fine_band_percent)
                    ),
                    valve_fine_tap_s=float(
                        body.get("valve_fine_tap_s", self.loop.config.valve_fine_tap_s)
                    ),
                    valve_fine_tap_pause_s=float(
                        body.get("valve_fine_tap_pause_s", self.loop.config.valve_fine_tap_pause_s)
                    ),
                    actuator_pause_s=float(body.get("actuator_pause_s", self.loop.config.actuator_pause_s)),
                )
                self._send_json({"ok": True})
                return
            if self.path == "/api/stop":
                self.loop.set_mode("manual")
                self.loop.set_manual_duty(0.0)
                self.loop.set_manual_actuator("pump", False)
                self.loop.set_manual_actuator("valve", False)
                self.loop.plant.actuators_off()
                self._send_json({"ok": True})
                return
            if self.path == "/api/calibrate-level":
                self.loop.set_mode("manual")
                self.loop.set_manual_duty(0.0)
                try:
                    self.loop.plant.actuators_off()
                except Exception:
                    self.loop.plant.reconnect()
                snapshot = self.loop.plant.read_snapshot()
                raw = snapshot.level_raw
                point = str(body.get("point", "")).lower()
                if point == "reset":
                    self.loop.config.level_empty_raw = 0
                    self.loop.config.level_full_raw = 0x7FF8
                elif point == "empty":
                    self.loop.config.level_empty_raw = raw
                elif point == "full":
                    if raw == self.loop.config.level_empty_raw:
                        raise ValueError("100% raw value must differ from 0% raw value")
                    self.loop.config.level_full_raw = raw
                else:
                    raise ValueError("point must be 'empty', 'full', or 'reset'")
                self.loop.config.save()
                self._send_json(
                    {
                        "ok": True,
                        "level_empty_raw": self.loop.config.level_empty_raw,
                        "level_full_raw": self.loop.config.level_full_raw,
                        "level_raw": raw,
                    }
                )
                return
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=400)
            return
        self._send(404, b"Not found", "text/plain")

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _send_json(self, data: dict[str, Any], status: int = 200) -> None:
        self._send(status, json.dumps(data).encode("utf-8"), "application/json")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self._send_common_headers(content_type, len(body))
        self.end_headers()
        self.wfile.write(body)

    def _send_common_headers(self, content_type: str, content_length: int) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


def main() -> None:
    parser = argparse.ArgumentParser(description="EduKit PA API server for the Next.js dashboard")
    parser.add_argument("--config", default="edukit_config.json")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    config = EduKitConfig.load(args.config)
    plant = EduKitPA(config)
    pid = PIDController(PIDConfig(output_min=-config.max_valve_percent, output_max=config.max_duty_percent))
    loop = ControlLoop(plant, pid, config)
    ApiHandler.loop = loop

    server = ThreadingHTTPServer((args.host, args.port), ApiHandler)
    stop_event = threading.Event()

    def shutdown(_signum: int, _frame: Any) -> None:
        stop_event.set()
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    loop.start()
    print(f"API running at http://{args.host}:{args.port}/")
    print("Press Ctrl+C to stop. Actuators are switched off on shutdown.")

    try:
        server.serve_forever()
    finally:
        loop.stop()
        plant.close()


if __name__ == "__main__":
    main()
