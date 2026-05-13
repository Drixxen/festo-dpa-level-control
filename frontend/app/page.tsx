"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Mode = "manual" | "auto";
type ControlStrategy = "three_point" | "pid";

type PIDTemplate = {
  id: string;
  name: string;
  kp: number;
  ki: number;
  kd: number;
  setpoint: number;
};

type Sample = {
  t: number;
  level: number;
  flow: number;
  pressure: number;
  duty: number;
  setpoint: number;
};

type PlantState = {
  level: number;
  flow: number;
  pressure: number;
  levelRaw: number;
  levelVoltage: number;
  flowRaw: number;
  flowVoltage: number;
  pressureRaw: number;
  pressureVoltage: number;
  pumpOn: boolean;
  drainValveOn: boolean;
  lowSwitch: boolean;
  highSwitch: boolean;
};

type BackendState = {
  mode: Mode;
  manual_duty_percent: number;
  manual_pump_hold: boolean;
  manual_valve_hold: boolean;
  controller_output_percent: number;
  pump_command_percent: number;
  control_action: string;
  actual_pump_on: boolean;
  actual_drain_valve_on: boolean;
  error: string | null;
  t_s: number;
  snapshot: {
    level_percent: number;
    flow_percent: number;
    pressure_percent: number;
    level_raw: number;
    level_voltage: number;
    flow_raw: number;
    flow_voltage: number;
    pressure_raw: number;
    pressure_voltage: number;
    level_low_switch: boolean;
    level_high_switch: boolean;
  } | null;
  pid: {
    kp: number;
    ki: number;
    kd: number;
    setpoint: number;
  };
  history: Array<{
    t: number;
    level: number;
    flow: number;
    pressure: number;
    duty: number;
  }>;
  autotune: {
    running?: boolean;
    status?: string;
    message?: string;
    elapsed_s?: number;
    crossings?: number;
    output_percent?: number;
    phase?: string;
    curve?: Array<{ output: number; flow: number; level: number }>;
    response?: Array<{ t: number; level: number; flow: number; output: number }>;
    flow_threshold_output?: number;
    deadtime_s?: number;
    max_slope_percent_s?: number;
    ku?: number;
    tu_s?: number;
    amplitude_percent?: number;
    kp?: number;
    ki?: number;
    kd?: number;
  };
  config: {
    pump_mode: string;
    pump_bit: number;
    pump_digital_control_bit: number;
    pump_analog_channel: number;
    level_empty_raw: number;
    level_full_raw: number;
    max_duty_percent: number;
    level_tolerance_percent: number;
    pump_overfill_percent: number;
    valve_tap_band_percent: number;
    valve_tap_s: number;
    valve_tap_pause_s: number;
    valve_fine_band_percent: number;
    valve_fine_tap_s: number;
    valve_fine_tap_pause_s: number;
    actuator_pause_s: number;
    min_pump_effective_percent: number;
    flow_start_threshold_percent: number;
    min_flow_percent: number;
    flow_boost_gain: number;
    autotune_output_percent: number;
    autotune_hysteresis_percent: number;
    autotune_curve_step_percent: number;
    autotune_curve_hold_s: number;
    autotune_start_level_percent: number;
    autotune_end_level_percent: number;
    control_strategy: ControlStrategy;
    three_point_pump_mode: string;
  };
};

const defaultTemplates: PIDTemplate[] = [
  { id: "gentle", name: "Sanftes PI", kp: 1.2, ki: 0.025, kd: 0, setpoint: 45 },
  { id: "fast", name: "Schneller PI", kp: 2.4, ki: 0.06, kd: 0, setpoint: 55 },
  { id: "p-only", name: "Nur P", kp: 2.0, ki: 0, kd: 0, setpoint: 50 }
];

const colors = {
  level: "#5bc8ff",
  flow: "#42d392",
  pressure: "#f7b955",
  duty: "#c7d2fe",
  compare: "#fb7185"
};

const controlApi = process.env.NEXT_PUBLIC_CONTROL_API ??
  (typeof window !== "undefined" ? `http://${window.location.hostname}:8080` : "http://127.0.0.1:8080");
function mockInitialPlant(): PlantState {
  return {
    level: 38,
    flow: 0,
    pressure: 7,
    levelRaw: Math.round(38 / 100 * 32760),
    levelVoltage: 3.8,
    flowRaw: 0,
    flowVoltage: 0,
    pressureRaw: Math.round(7 / 100 * 32760),
    pressureVoltage: 0.7,
    pumpOn: false,
    drainValveOn: false,
    lowSwitch: true,
    highSwitch: false
  };
}

async function postControl(path: string, body: Record<string, unknown>) {
  try {
    await fetchWithTimeout(`${controlApi}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, 700);
  } catch {
    // The UI keeps its local/mock state when the Python control backend is not running.
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 700) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function Page() {
  const [mode, setMode] = useState<Mode>("manual");
  const [manualDuty, setManualDuty] = useState(0);
  const [pid, setPid] = useState<PIDTemplate>(defaultTemplates[0]);
  const [templates, setTemplates] = useState<PIDTemplate[]>(defaultTemplates);
  const [selectedTemplateId, setSelectedTemplateId] = useState(defaultTemplates[0].id);
  const [plant, setPlant] = useState<PlantState>(() => mockInitialPlant());
  const [history, setHistory] = useState<Sample[]>([]);
  const [compareRuns, setCompareRuns] = useState<{ name: string; samples: Sample[] }[]>([]);
  const [beerMode, setBeerMode] = useState(false);
  const [liveConnected, setLiveConnected] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [liveDuty, setLiveDuty] = useState(0);
  const [pumpCommand, setPumpCommand] = useState(0);
  const [controlAction, setControlAction] = useState("idle");
  const [pumpIo, setPumpIo] = useState({ mode: "digital_pwm", bit: 3, analogEnableBit: 2, analogChannel: 0 });
  const [controlStrategy, setControlStrategy] = useState<ControlStrategy>("three_point");
  const [levelTolerance, setLevelTolerance] = useState(3);
  const [maxPumpOutput, setMaxPumpOutput] = useState(60);
  const [pumpOverfill, setPumpOverfill] = useState(1);
  const [valveTapBand, setValveTapBand] = useState(5);
  const [valveTap, setValveTap] = useState(0.4);
  const [valveTapPause, setValveTapPause] = useState(1.8);
  const [valveFineBand, setValveFineBand] = useState(2);
  const [valveFineTap, setValveFineTap] = useState(0.15);
  const [valveFineTapPause, setValveFineTapPause] = useState(1.2);
  const [actuatorPause, setActuatorPause] = useState(1.5);
  const [minPumpEffective, setMinPumpEffective] = useState(25);
  const [flowStartThreshold, setFlowStartThreshold] = useState(3);
  const [minFlow, setMinFlow] = useState(8);
  const [flowBoostGain, setFlowBoostGain] = useState(4);
  const [autotuneOutput, setAutotuneOutput] = useState(45);
  const [autotuneHysteresis, setAutotuneHysteresis] = useState(2);
  const [autotuneCurveStep, setAutotuneCurveStep] = useState(10);
  const [autotuneCurveHold, setAutotuneCurveHold] = useState(4);
  const [autotuneStartLevel, setAutotuneStartLevel] = useState(5);
  const [autotuneEndLevel, setAutotuneEndLevel] = useState(70);
  const [autotune, setAutotune] = useState<BackendState["autotune"]>({});
  const [autotuneOpen, setAutotuneOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [levelScale, setLevelScale] = useState({ empty: 0, full: 32760 });
  const [levelRawRange, setLevelRawRange] = useState({ min: 0, max: 0, initialized: false });
  const [calibrationMessage, setCalibrationMessage] = useState("");
  const simRef = useRef({ integral: 0, previousError: 0, t: 0 });
  const wasLiveConnectedRef = useRef(false);
  const heldActuatorRef = useRef<"pump" | "valve" | null>(null);

  const activeDuty = useMemo(() => {
    if (liveConnected) return liveDuty;
    if (mode === "manual") return manualDuty;
    const error = pid.setpoint - plant.level;
    if (controlStrategy === "pid") {
      simRef.current.integral = clamp(simRef.current.integral + error * 0.2, -400, 400);
      const derivative = (error - simRef.current.previousError) / 0.2;
      simRef.current.previousError = error;
      return clamp(pid.kp * error + pid.ki * simRef.current.integral + pid.kd * derivative, -100, 100);
    }
    simRef.current.previousError = error;
    if (error > levelTolerance) return 100;
    if (error < -levelTolerance) return -100;
    return 0;
  }, [liveConnected, liveDuty, mode, manualDuty, controlStrategy, pid.kp, pid.ki, pid.kd, pid.setpoint, plant.level, levelTolerance]);
  const pumpOutputLabel = pumpIo.mode === "analog" ? `DO${pumpIo.analogEnableBit}+DO${pumpIo.bit}+AO${pumpIo.analogChannel}` : `DO${pumpIo.bit}`;
  const autoModeLabel = controlStrategy === "pid" ? "Auto PID" : "Auto 3-Punkt";
  const requestedPumpOutput = Math.max(0, activeDuty);
  const pumpCommandVoltage = pumpCommand / 10;

  useEffect(() => {
    const stored = window.localStorage.getItem("edukit-pid-templates");
    if (stored) {
      const parsed = JSON.parse(stored) as PIDTemplate[];
      if (parsed.length) {
        setTemplates(parsed);
        setPid(parsed[0]);
        setSelectedTemplateId(parsed[0].id);
      }
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("edukit-pid-templates", JSON.stringify(templates));
  }, [templates]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (liveConnected) return;
      setPlant((current) => {
        const duty = mode === "manual" ? manualDuty : activeDuty;
        const pumpDuty = Math.max(0, duty);
        const simulatedPumpCommand = pumpDuty > 1 && pumpDuty < minPumpEffective ? minPumpEffective : pumpDuty;
        const valveDuty = Math.max(0, -duty);
        const inflow = simulatedPumpCommand * 0.055;
        const outflow = 1.15 + current.level * 0.012 + valveDuty * 0.05;
        const nextLevel = clamp(current.level + (inflow - outflow) * 0.2, 0, 100);
        const nextFlow = smooth(current.flow, duty * 0.92 + Math.random() * 2.5, 0.28);
        const nextPressure = smooth(current.pressure, 5 + duty * 0.21 + Math.random() * 1.5, 0.22);
        const pumpOn = pumpDuty > 1;
        setPumpCommand(pumpOn ? simulatedPumpCommand : 0);
        const drainValveOn = valveDuty > 1;
        const next = {
          level: nextLevel,
          flow: clamp(nextFlow, 0, 100),
          pressure: clamp(nextPressure, 0, 100),
          levelRaw: Math.round(nextLevel / 100 * 32760),
          levelVoltage: nextLevel / 10,
          flowRaw: Math.round(nextFlow / 100 * 32760),
          flowVoltage: nextFlow / 10,
          pressureRaw: Math.round(nextPressure / 100 * 32760),
          pressureVoltage: nextPressure / 10,
          pumpOn,
          drainValveOn,
          lowSwitch: nextLevel > 26,
          highSwitch: nextLevel > 78
        };
        simRef.current.t += 0.2;
        const sample = {
          t: simRef.current.t,
          level: next.level,
          flow: next.flow,
          pressure: next.pressure,
          duty,
          setpoint: pid.setpoint
        };
        setHistory((items) => [...items.slice(-449), sample]);
        return next;
      });
    }, 200);
    return () => window.clearInterval(timer);
  }, [activeDuty, liveConnected, manualDuty, minPumpEffective, mode, pid.setpoint]);

  useEffect(() => {
    let cancelled = false;
    async function refreshLive() {
      try {
        const response = await fetchWithTimeout(`${controlApi}/api/state`, { cache: "no-store" }, 700);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const state = (await response.json()) as BackendState;
        if (state.error) throw new Error(state.error);
        if (cancelled) return;
        setLiveConnected(true);
        wasLiveConnectedRef.current = true;
        setBackendError(null);
        setMode(state.mode);
        setManualDuty(state.manual_duty_percent);
        setLiveDuty(state.controller_output_percent);
        setPumpCommand(state.pump_command_percent);
        setControlAction(state.control_action);
        setAutotune(state.autotune ?? {});
        setControlStrategy(state.config.control_strategy);
        setPumpIo({
          mode: state.config.pump_mode,
          bit: state.config.pump_bit,
          analogEnableBit: state.config.pump_digital_control_bit,
          analogChannel: state.config.pump_analog_channel
        });
        setMaxPumpOutput(state.config.max_duty_percent);
        setLevelTolerance(state.config.level_tolerance_percent);
        setPumpOverfill(state.config.pump_overfill_percent);
        setValveTapBand(state.config.valve_tap_band_percent);
        setValveTap(state.config.valve_tap_s);
        setValveTapPause(state.config.valve_tap_pause_s);
        setValveFineBand(state.config.valve_fine_band_percent);
        setValveFineTap(state.config.valve_fine_tap_s);
        setValveFineTapPause(state.config.valve_fine_tap_pause_s);
        setActuatorPause(state.config.actuator_pause_s);
        setMinPumpEffective(state.config.min_pump_effective_percent);
        setFlowStartThreshold(state.config.flow_start_threshold_percent);
        setMinFlow(state.config.min_flow_percent);
        setFlowBoostGain(state.config.flow_boost_gain);
        setAutotuneOutput(state.config.autotune_output_percent);
        setAutotuneHysteresis(state.config.autotune_hysteresis_percent);
        setAutotuneCurveStep(state.config.autotune_curve_step_percent);
        setAutotuneCurveHold(state.config.autotune_curve_hold_s);
        setAutotuneStartLevel(state.config.autotune_start_level_percent);
        setAutotuneEndLevel(state.config.autotune_end_level_percent);
        if (state.autotune?.running) setAutotuneOpen(true);
        setLevelScale({
          empty: state.config.level_empty_raw,
          full: state.config.level_full_raw
        });
        setPid((current) => ({
          ...current,
          kp: state.pid.kp,
          ki: state.pid.ki,
          kd: state.pid.kd,
          setpoint: state.pid.setpoint
        }));
        const snapshot = state.snapshot;
        if (snapshot) {
          setLevelRawRange((range) => {
            if (!range.initialized) {
              return { min: snapshot.level_raw, max: snapshot.level_raw, initialized: true };
            }
            return {
              min: Math.min(range.min, snapshot.level_raw),
              max: Math.max(range.max, snapshot.level_raw),
              initialized: true
            };
          });
          setPlant({
            level: snapshot.level_percent,
            flow: snapshot.flow_percent,
            pressure: snapshot.pressure_percent,
            levelRaw: snapshot.level_raw,
            levelVoltage: snapshot.level_voltage,
            flowRaw: snapshot.flow_raw,
            flowVoltage: snapshot.flow_voltage,
            pressureRaw: snapshot.pressure_raw,
            pressureVoltage: snapshot.pressure_voltage,
            pumpOn: state.actual_pump_on,
            drainValveOn: state.actual_drain_valve_on,
            lowSwitch: snapshot.level_low_switch,
            highSwitch: snapshot.level_high_switch
          });
        }
        setHistory(
          state.history.map((point) => ({
            ...point,
            setpoint: state.pid.setpoint
          }))
        );
      } catch (error) {
        if (!cancelled) {
          if (wasLiveConnectedRef.current) {
            simRef.current = { integral: 0, previousError: 0, t: 0 };
            wasLiveConnectedRef.current = false;
            setMode("manual");
            setManualDuty(0);
            setLiveDuty(0);
            setHistory([]);
            setPlant(mockInitialPlant());
            setLevelScale({ empty: 0, full: 32760 });
          }
          setLiveConnected(false);
          setBackendError(error instanceof Error ? error.message : "Keine Verbindung");
        }
      }
    }
    refreshLive();
    const timer = window.setInterval(refreshLive, 250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const selectedTemplate = templates.find((item) => item.id === selectedTemplateId) ?? templates[0];
  const isAtSetpoint = Math.abs(plant.level - pid.setpoint) <= levelTolerance;

  function updatePid(key: keyof Omit<PIDTemplate, "id" | "name">, value: number) {
    setPid((current) => {
      const next = { ...current, [key]: value };
      postControl("/api/pid", {
        setpoint: next.setpoint,
        kp: next.kp,
        ki: next.ki,
        kd: next.kd
      });
      return next;
    });
  }

  function updateTolerance(value: number) {
    const next = clamp(value, 0.2, 20);
    setLevelTolerance(next);
    postControl("/api/config", {
      level_tolerance_percent: next,
      max_duty_percent: maxPumpOutput,
      pump_overfill_percent: pumpOverfill,
      valve_tap_band_percent: valveTapBand,
      valve_tap_s: valveTap,
      valve_tap_pause_s: valveTapPause,
      valve_fine_band_percent: valveFineBand,
      valve_fine_tap_s: valveFineTap,
      valve_fine_tap_pause_s: valveFineTapPause,
      actuator_pause_s: actuatorPause,
      min_pump_effective_percent: minPumpEffective,
      flow_start_threshold_percent: flowStartThreshold,
      min_flow_percent: minFlow,
      flow_boost_gain: flowBoostGain,
      autotune_output_percent: autotuneOutput,
      autotune_hysteresis_percent: autotuneHysteresis,
      autotune_curve_step_percent: autotuneCurveStep,
      autotune_curve_hold_s: autotuneCurveHold,
      autotune_start_level_percent: autotuneStartLevel,
      autotune_end_level_percent: autotuneEndLevel,
      control_strategy: controlStrategy,
      three_point_pump_mode: pumpIo.mode
    });
  }

  function updateControlTuning(key: "max_duty_percent" | "pump_overfill_percent" | "valve_tap_band_percent" | "valve_tap_s" | "valve_tap_pause_s" | "valve_fine_band_percent" | "valve_fine_tap_s" | "valve_fine_tap_pause_s" | "actuator_pause_s" | "min_pump_effective_percent" | "flow_start_threshold_percent" | "min_flow_percent" | "flow_boost_gain" | "autotune_output_percent" | "autotune_hysteresis_percent" | "autotune_curve_step_percent" | "autotune_curve_hold_s" | "autotune_start_level_percent" | "autotune_end_level_percent", value: number) {
    const nextMaxPump = key === "max_duty_percent" ? clamp(value, 5, 100) : maxPumpOutput;
    const nextPumpOverfill = key === "pump_overfill_percent" ? clamp(value, 0, 10) : pumpOverfill;
    const nextValveTapBand = key === "valve_tap_band_percent" ? clamp(value, 0.5, 30) : valveTapBand;
    const nextValveTap = key === "valve_tap_s" ? clamp(value, 0.05, 5) : valveTap;
    const nextValvePause = key === "valve_tap_pause_s" ? clamp(value, 0, 20) : valveTapPause;
    const nextFineBand = key === "valve_fine_band_percent" ? clamp(value, 0.2, 20) : valveFineBand;
    const nextFineTap = key === "valve_fine_tap_s" ? clamp(value, 0.03, 2) : valveFineTap;
    const nextFinePause = key === "valve_fine_tap_pause_s" ? clamp(value, 0, 20) : valveFineTapPause;
    const nextPause = key === "actuator_pause_s" ? clamp(value, 0, 20) : actuatorPause;
    const nextMinPump = key === "min_pump_effective_percent" ? clamp(value, 0, 80) : minPumpEffective;
    const nextFlowThreshold = key === "flow_start_threshold_percent" ? clamp(value, 0, 30) : flowStartThreshold;
    const nextMinFlow = key === "min_flow_percent" ? clamp(value, 0, 50) : minFlow;
    const nextFlowBoostGain = key === "flow_boost_gain" ? clamp(value, 0, 12) : flowBoostGain;
    const nextAutotuneOutput = key === "autotune_output_percent" ? clamp(value, 5, 100) : autotuneOutput;
    const nextAutotuneHysteresis = key === "autotune_hysteresis_percent" ? clamp(value, 0.5, 15) : autotuneHysteresis;
    const nextAutotuneCurveStep = key === "autotune_curve_step_percent" ? clamp(value, 1, 25) : autotuneCurveStep;
    const nextAutotuneCurveHold = key === "autotune_curve_hold_s" ? clamp(value, 1, 20) : autotuneCurveHold;
    const nextAutotuneStartLevel = key === "autotune_start_level_percent" ? clamp(value, 0, 40) : autotuneStartLevel;
    const nextAutotuneEndLevel = key === "autotune_end_level_percent" ? clamp(value, 20, 95) : autotuneEndLevel;
    setMaxPumpOutput(nextMaxPump);
    setPumpOverfill(nextPumpOverfill);
    setValveTapBand(nextValveTapBand);
    setValveTap(nextValveTap);
    setValveTapPause(nextValvePause);
    setValveFineBand(nextFineBand);
    setValveFineTap(nextFineTap);
    setValveFineTapPause(nextFinePause);
    setActuatorPause(nextPause);
    setMinPumpEffective(nextMinPump);
    setFlowStartThreshold(nextFlowThreshold);
    setMinFlow(nextMinFlow);
    setFlowBoostGain(nextFlowBoostGain);
    setAutotuneOutput(nextAutotuneOutput);
    setAutotuneHysteresis(nextAutotuneHysteresis);
    setAutotuneCurveStep(nextAutotuneCurveStep);
    setAutotuneCurveHold(nextAutotuneCurveHold);
    setAutotuneStartLevel(nextAutotuneStartLevel);
    setAutotuneEndLevel(nextAutotuneEndLevel);
    postControl("/api/config", {
      level_tolerance_percent: levelTolerance,
      max_duty_percent: nextMaxPump,
      pump_overfill_percent: nextPumpOverfill,
      valve_tap_band_percent: nextValveTapBand,
      valve_tap_s: nextValveTap,
      valve_tap_pause_s: nextValvePause,
      valve_fine_band_percent: nextFineBand,
      valve_fine_tap_s: nextFineTap,
      valve_fine_tap_pause_s: nextFinePause,
      actuator_pause_s: nextPause,
      min_pump_effective_percent: nextMinPump,
      flow_start_threshold_percent: nextFlowThreshold,
      min_flow_percent: nextMinFlow,
      flow_boost_gain: nextFlowBoostGain,
      autotune_output_percent: nextAutotuneOutput,
      autotune_hysteresis_percent: nextAutotuneHysteresis,
      autotune_curve_step_percent: nextAutotuneCurveStep,
      autotune_curve_hold_s: nextAutotuneCurveHold,
      autotune_start_level_percent: nextAutotuneStartLevel,
      autotune_end_level_percent: nextAutotuneEndLevel,
      control_strategy: controlStrategy,
      three_point_pump_mode: pumpIo.mode
    });
  }

  function updateControlStrategy(strategy: ControlStrategy) {
    setControlStrategy(strategy);
    simRef.current.integral = 0;
    simRef.current.previousError = 0;
    postControl("/api/config", {
      level_tolerance_percent: levelTolerance,
      max_duty_percent: maxPumpOutput,
      pump_overfill_percent: pumpOverfill,
      valve_tap_band_percent: valveTapBand,
      valve_tap_s: valveTap,
      valve_tap_pause_s: valveTapPause,
      valve_fine_band_percent: valveFineBand,
      valve_fine_tap_s: valveFineTap,
      valve_fine_tap_pause_s: valveFineTapPause,
      actuator_pause_s: actuatorPause,
      min_pump_effective_percent: minPumpEffective,
      flow_start_threshold_percent: flowStartThreshold,
      min_flow_percent: minFlow,
      flow_boost_gain: flowBoostGain,
      autotune_output_percent: autotuneOutput,
      autotune_hysteresis_percent: autotuneHysteresis,
      autotune_curve_step_percent: autotuneCurveStep,
      autotune_curve_hold_s: autotuneCurveHold,
      autotune_start_level_percent: autotuneStartLevel,
      autotune_end_level_percent: autotuneEndLevel,
      control_strategy: strategy,
      three_point_pump_mode: pumpIo.mode
    });
  }

  function selectOperation(next: "manual" | ControlStrategy) {
    if (next === "manual") {
      setControlMode("manual");
      return;
    }
    updateControlStrategy(next);
    setControlMode("auto");
  }

  function startAutotune() {
    setControlMode("auto");
    setAutotuneOpen(true);
    postControl("/api/autotune/start", {});
  }

  function stopAutotune() {
    postControl("/api/autotune/stop", {});
  }

  function saveCurrentSettings() {
    const nextSetpoint = readReglerInput("setpoint", pid.setpoint);
    const nextTolerance = readReglerInput("tolerance", levelTolerance);
    const nextMinPump = readReglerInput("min-pump", minPumpEffective);
    const nextMinFlow = readReglerInput("min-flow", minFlow);
    const nextMaxPump = readReglerInput("max-pump", maxPumpOutput);
    const nextKp = readReglerInput("kp", pid.kp);
    const nextKi = readReglerInput("ki", pid.ki);
    const nextKd = readReglerInput("kd", pid.kd);
    const nextPid = {
      ...pid,
      setpoint: nextSetpoint,
      kp: nextKp,
      ki: nextKi,
      kd: nextKd
    };
    setPid(nextPid);
    setLevelTolerance(nextTolerance);
    setMinPumpEffective(nextMinPump);
    setMinFlow(nextMinFlow);
    setMaxPumpOutput(nextMaxPump);
    const settings = {
      pid: nextPid,
      levelTolerance: nextTolerance,
      minPumpEffective: nextMinPump,
      minFlow: nextMinFlow,
      maxPumpOutput: nextMaxPump,
      savedAt: new Date().toISOString()
    };
    window.localStorage.setItem("edukit-regler-settings", JSON.stringify(settings));
    postControl("/api/pid", {
      setpoint: nextPid.setpoint,
      kp: nextPid.kp,
      ki: nextPid.ki,
      kd: nextPid.kd
    });
    postControl("/api/config", {
      level_tolerance_percent: nextTolerance,
      max_duty_percent: nextMaxPump,
      pump_overfill_percent: pumpOverfill,
      valve_tap_band_percent: valveTapBand,
      valve_tap_s: valveTap,
      valve_tap_pause_s: valveTapPause,
      valve_fine_band_percent: valveFineBand,
      valve_fine_tap_s: valveFineTap,
      valve_fine_tap_pause_s: valveFineTapPause,
      actuator_pause_s: actuatorPause,
      min_pump_effective_percent: nextMinPump,
      flow_start_threshold_percent: flowStartThreshold,
      min_flow_percent: nextMinFlow,
      flow_boost_gain: flowBoostGain,
      autotune_output_percent: autotuneOutput,
      autotune_hysteresis_percent: autotuneHysteresis,
      autotune_curve_step_percent: autotuneCurveStep,
      autotune_curve_hold_s: autotuneCurveHold,
      autotune_start_level_percent: autotuneStartLevel,
      autotune_end_level_percent: autotuneEndLevel,
      control_strategy: controlStrategy,
      three_point_pump_mode: pumpIo.mode
    });
    setSettingsMessage("Einstellungen gespeichert");
    window.setTimeout(() => setSettingsMessage(""), 2200);
  }

  function loadTemplate(template: PIDTemplate) {
    setPid(template);
    setSelectedTemplateId(template.id);
    simRef.current.integral = 0;
    simRef.current.previousError = 0;
    postControl("/api/pid", {
      setpoint: template.setpoint,
      kp: template.kp,
      ki: template.ki,
      kd: template.kd
    });
  }

  function saveTemplate() {
    const name = selectedTemplate?.name || "Regler";
    const next = { ...pid, id: crypto.randomUUID(), name: `${name} Kopie` };
    setTemplates((items) => [next, ...items]);
    setSelectedTemplateId(next.id);
  }

  function updateTemplate() {
    setTemplates((items) =>
      items.map((item) => (item.id === selectedTemplateId ? { ...pid, id: item.id, name: item.name } : item))
    );
    postControl("/api/pid", {
      setpoint: pid.setpoint,
      kp: pid.kp,
      ki: pid.ki,
      kd: pid.kd
    });
  }

  function renameTemplate(name: string) {
    setTemplates((items) => items.map((item) => (item.id === selectedTemplateId ? { ...item, name } : item)));
  }

  function saveRun() {
    if (history.length < 5) return;
    setCompareRuns((runs) => [{ name: selectedTemplate?.name ?? "Regler", samples: history.slice() }, ...runs.slice(0, 2)]);
  }

  function resetSimulation() {
    simRef.current = { integral: 0, previousError: 0, t: 0 };
    setHistory([]);
    setPlant(mockInitialPlant());
  }

  async function calibrateLevel(point: "empty" | "full" | "reset") {
    setCalibrationMessage("Kalibriere...");
    try {
      const response = await fetch(`${controlApi}/api/calibrate-level`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ point })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setLevelScale({ empty: result.level_empty_raw, full: result.level_full_raw });
      const label = point === "empty" ? "0 %" : point === "full" ? "100 %" : "Default";
      setCalibrationMessage(`${label} gespeichert · raw ${result.level_raw}`);
    } catch (error) {
      setCalibrationMessage(error instanceof Error ? error.message : "Kalibrierung fehlgeschlagen");
    }
  }

  function resetLevelRawRange() {
    setLevelRawRange({ min: plant.levelRaw, max: plant.levelRaw, initialized: true });
  }

  function setControlMode(nextMode: Mode) {
    if (nextMode === "auto") simRef.current.integral = 0;
    setMode(nextMode);
    postControl("/api/mode", { mode: nextMode });
  }

  function holdActuator(actuator: "pump" | "valve", enabled: boolean) {
    if (!enabled && heldActuatorRef.current !== actuator) return;
    heldActuatorRef.current = enabled ? actuator : null;
    setMode("manual");
    setManualDuty(0);
    setLiveDuty(enabled ? (actuator === "pump" ? 100 : -100) : 0);
    setPlant((current) => ({
      ...current,
      pumpOn: actuator === "pump" ? enabled : enabled ? false : current.pumpOn,
      drainValveOn: actuator === "valve" ? enabled : enabled ? false : current.drainValveOn
    }));
    postControl("/api/actuator", { actuator, enabled });
  }

  function stopPump() {
    setMode("manual");
    setManualDuty(0);
    setLiveDuty(0);
    postControl("/api/stop", {});
  }

  return (
    <>
    <main className="appShell">
      <header className="topbar">
        <div className="brand">
          <div className="mark" aria-hidden="true" />
          <div>
            <h1>EduKit PA Control</h1>
            <span>Füllstandsregelung · {liveConnected ? "Live-Modus" : "Mock-Modus"}</span>
          </div>
        </div>
        <div className="topActions">
          <span className="statusPill">
            <span className="dot" />
            {mode === "auto" ? autoModeLabel : "Manuell"} · Pumpe {plant.pumpOn ? "AN" : "AUS"} · Ventil {plant.drainValveOn ? "AUF" : "ZU"}
          </span>
          <span className={`statusPill ${liveConnected && !backendError ? "live" : "warn"}`}>
            {liveConnected && !backendError ? "Live verbunden" : "Offline"}
          </span>
          <button className="ghost iconButton" onClick={() => setInfoOpen(true)} aria-label="Info">i</button>
          <button className="ghost" onClick={() => setAutotuneOpen(true)}>Autotune</button>
          <button className="ghost" onClick={resetSimulation}>Reset</button>
          <button className="danger" onClick={stopPump}>Anlage aus</button>
        </div>
      </header>

      <section className="grid">
        <aside className="column">
          <div className="widget compactWidget">
            <div className="widgetHeader">
              <div>
                <h2>Betrieb</h2>
                <span className="muted">Modus und Stellglied</span>
              </div>
              <span className={`chip ${plant.pumpOn ? "on" : ""}`}>{plant.pumpOn ? "aktiv" : "bereit"}</span>
            </div>
            <div className="segmented modeSegmented">
              <button className={mode === "manual" ? "active" : ""} onClick={() => selectOperation("manual")}>Manuell</button>
              <button className={mode === "auto" && controlStrategy === "three_point" ? "active" : ""} onClick={() => selectOperation("three_point")}>3 Punkt</button>
              <button className={mode === "auto" && controlStrategy === "pid" ? "active" : ""} onClick={() => selectOperation("pid")}>PID</button>
            </div>
            <div className="holdControls">
              <button
                className={`holdButton ${plant.pumpOn ? "active" : ""}`}
                onPointerDown={() => holdActuator("pump", true)}
                onPointerUp={() => holdActuator("pump", false)}
                onPointerLeave={() => holdActuator("pump", false)}
                onPointerCancel={() => holdActuator("pump", false)}
              >
                Pumpe halten
              </button>
              <button
                className={`holdButton ${plant.drainValveOn ? "active" : ""}`}
                onPointerDown={() => holdActuator("valve", true)}
                onPointerUp={() => holdActuator("valve", false)}
                onPointerLeave={() => holdActuator("valve", false)}
                onPointerCancel={() => holdActuator("valve", false)}
              >
                Ventil öffnen
              </button>
            </div>
            <details className="expertPanel">
              <summary>Kalibrierung</summary>
              <div className="calibrationBox">
                <div className="calibrationReadout calibrationReadoutGrid">
                  <span>Aktuell</span><strong>raw {plant.levelRaw} · {plant.levelVoltage.toFixed(3)} V</strong>
                  <span>Min/Max</span><strong>{levelRawRange.min} / {levelRawRange.max}</strong>
                  <span>Spannweite</span><strong>{Math.max(0, levelRawRange.max - levelRawRange.min)} raw</strong>
                  <span>Skala</span><strong>{levelScale.empty} / {levelScale.full}</strong>
                  <span>Richtung</span><strong>{levelScale.full >= levelScale.empty ? "raw steigt mit Füllstand" : "raw fällt mit Füllstand"}</strong>
                </div>
                <div className="calibrationHint">
                  Erst unteren Referenzstand herstellen und 0 % speichern. Danach oberen Referenzstand herstellen und 100 % speichern.
                </div>
                <div className="calibrationActions two">
                  <button onClick={() => calibrateLevel("empty")}>Aktueller Stand = 0 %</button>
                  <button onClick={() => calibrateLevel("full")}>Aktueller Stand = 100 %</button>
                </div>
              <button className="ghost compactAction" onClick={resetLevelRawRange}>Min/Max zurücksetzen</button>
              <button className="ghost compactAction" onClick={() => calibrateLevel("reset")}>Skala auf Default</button>
              {calibrationMessage ? <div className="calibrationMessage">{calibrationMessage}</div> : null}
            </div>
            </details>
          </div>

          <div className="widget regulatorWidget">
            <div className="widgetHeader">
              <div>
                <h2>Regler</h2>
                <span className="muted">Sollwert und Regler</span>
              </div>
              <span className="chip">{activeDuty >= 0 ? "+" : ""}{activeDuty.toFixed(1)} %</span>
            </div>
            <div className="simpleControl">
              <div className="setpointRow">
                <ApplyNumberField inputName="setpoint" label="Sollwert %" value={pid.setpoint} step={1} onApply={(value) => updatePid("setpoint", value)} />
              </div>
              <div className="quickTuneGrid">
                <NumberField inputName="tolerance" label="Toleranz %" value={levelTolerance} step={0.5} onChange={updateTolerance} />
                <NumberField inputName="min-pump" label="Mindest-Pumpe %" value={minPumpEffective} step={1} onChange={(value) => updateControlTuning("min_pump_effective_percent", value)} />
              </div>
              <div className="quickTuneGrid">
                <NumberField inputName="min-flow" label="Mindestdurchfluss %" value={minFlow} step={0.5} onChange={(value) => updateControlTuning("min_flow_percent", value)} />
                <NumberField inputName="max-pump" label="Max Pumpe %" value={maxPumpOutput} step={1} onChange={(value) => updateControlTuning("max_duty_percent", value)} />
              </div>
            </div>
            <div className="pidTunePanel">
              <NumberField inputName="kp" label="Kp" value={pid.kp} step={0.1} onChange={(value) => updatePid("kp", value)} />
              <NumberField inputName="ki" label="Ki" value={pid.ki} step={0.005} onChange={(value) => updatePid("ki", value)} />
              <NumberField inputName="kd" label="Kd" value={pid.kd} step={0.05} onChange={(value) => updatePid("kd", value)} />
              <button className="primary wide" onClick={saveCurrentSettings}>Einstellungen speichern</button>
              {settingsMessage ? <div className="saveMessage wide">{settingsMessage}</div> : null}
            </div>
          </div>
        </aside>

        <section className="column">
          <div className="metricGrid">
            <Metric label="Füllstand AI1" value={plant.level} unit="%" sub={`raw ${plant.levelRaw} · ${plant.levelVoltage.toFixed(3)} V · ${pid.setpoint.toFixed(0)} % Soll`} />
            <Metric label="Durchfluss AI2" value={plant.flow} unit="%" sub={liveConnected ? `raw ${plant.flowRaw} · ${plant.flowVoltage.toFixed(3)} V` : "Mock-Skalierung"} />
            <Metric label="Druck AI3" value={plant.pressure} unit="%" sub={liveConnected ? `raw ${plant.pressureRaw} · ${plant.pressureVoltage.toFixed(3)} V` : "Mock-Skalierung"} />
            <Metric label="Stellgröße AO0" value={pumpCommand} unit="%" sub={`${pumpCommandVoltage.toFixed(2)} V · min ${minPumpEffective.toFixed(0)} % · ${pumpOutputLabel}`} />
          </div>

          <div className="workArea">
            <div className="widget plantWidget">
              <div className="widgetHeader">
                <div>
                  <h2>Anlage</h2>
                  <span className="muted">Oberer Tank · AI1</span>
                </div>
                <div className="sensorChips">
                  <button className={`beerButton ${beerMode ? "active" : ""}`} onClick={() => setBeerMode((enabled) => !enabled)}>Bierod</button>
                  <span className={`chip ${plant.lowSwitch ? "on" : ""}`}>DI3</span>
                  <span className={`chip ${plant.highSwitch ? "on" : ""}`}>DI4</span>
                </div>
              </div>
              <div className="plantScene">
                <div className="tankWrap">
                  <div className={`tank ${beerMode ? "beer" : ""} ${!beerMode && isAtSetpoint ? "inTolerance" : ""}`}>
                    <div
                      className="ultrasonicHead"
                      title={`Ultraschall AI1: ${plant.level.toFixed(1)} % · raw ${plant.levelRaw} · ${plant.levelVoltage.toFixed(3)} V`}
                    >
                      <span />
                    </div>
                    <div className="ultrasonicBeam" style={{ height: `${Math.max(10, 100 - clamp(plant.level, 0, 100))}%` }} />
                    <div className="returnPort top" />
                    <div className="returnPort bottom" />
                    <div
                      className={`sensor high ${plant.highSwitch ? "on" : ""}`}
                      title={`DI4 oben: ${plant.highSwitch ? "aktiv" : "inaktiv"} · Füllstand ${plant.level.toFixed(1)} %`}
                    />
                    <div
                      className={`sensor low ${plant.lowSwitch ? "on" : ""}`}
                      title={`DI3 unten: ${plant.lowSwitch ? "aktiv" : "inaktiv"} · Füllstand ${plant.level.toFixed(1)} %`}
                    />
                    <div className="water" style={{ height: `${clamp(plant.level, 0, 100)}%` }}>
                      <span className="beerFoam" />
                      <span className="beerBubble one" />
                      <span className="beerBubble two" />
                      <span className="beerBubble three" />
                      <span className="beerBubble four" />
                      <span className="beerBubble five" />
                    </div>
                  </div>
                  <div className="tankLabel"><span>Füllstand</span><strong>{plant.level.toFixed(1)} %</strong></div>
                </div>
                <div className="actuatorStack">
                  <div className={`returnLoop ${plant.pumpOn ? "on" : ""} ${beerMode ? "beer" : ""}`} title={`Ruecklauf AI2: ${plant.flow.toFixed(1)} %`}>
                    <svg viewBox="0 0 96 330" aria-hidden="true">
                      <path className="returnPipeShadow" d="M0 292 H66 Q82 292 82 276 V54 Q82 38 66 38 H0" />
                      <path className="returnPipe" d="M0 292 H66 Q82 292 82 276 V54 Q82 38 66 38 H0" />
                      <path className="returnFlow" d="M0 292 H66 Q82 292 82 276 V54 Q82 38 66 38 H0" />
                    </svg>
                  </div>
                  <div className={`pump ${plant.pumpOn ? "on" : ""}`} title={`Pumpe ${pumpOutputLabel}: ${plant.pumpOn ? "AN" : "AUS"} · Stellwert ${Math.max(0, activeDuty).toFixed(1)} %`}><div className="pumpIcon" /></div>
                  <span className="pipeLabel">{pumpOutputLabel}</span>
                  <span className={`chip valveChip ${plant.drainValveOn ? "on" : ""}`} title={`Ablassventil M102: ${plant.drainValveOn ? "AUF" : "ZU"}`}>M102</span>
                </div>
              </div>
            </div>

            <div className="widget trendWidget">
              <div className="widgetHeader">
                <div>
                  <h2>Verlauf</h2>
                  <span className="muted">Live und Vergleich</span>
                </div>
                <button onClick={saveRun}>Lauf merken</button>
              </div>
              <TrendChart samples={history} compareRuns={compareRuns} />
              <div className="legend">
                <span><span className="swatch" style={{ background: colors.level }} />Füllstand</span>
                <span><span className="swatch" style={{ background: colors.flow }} />Durchfluss</span>
                <span><span className="swatch" style={{ background: colors.pressure }} />Druck</span>
                <span><span className="swatch" style={{ background: colors.duty }} />Impuls +Pumpe / -Ventil</span>
                <span><span className="swatch" style={{ background: colors.compare }} />Vergleich</span>
              </div>
            </div>
          </div>
        </section>
      </section>
    </main>
    {autotuneOpen ? (
      <div className="infoOverlay" role="dialog" aria-modal="true">
        <div className="infoPanel autotunePanel">
          <div className="infoHeader">
            <div>
              <h2>Autotune</h2>
              <span>{autotune.message ?? "Kennlinie und Sprungantwort"}</span>
            </div>
            <div className="modalActions">
              {autotune.running ? <button className="danger" onClick={stopAutotune}>Stop</button> : <button className="primary" onClick={startAutotune}>Start</button>}
              <button onClick={() => setAutotuneOpen(false)}>Schließen</button>
            </div>
          </div>
          <div className="autotuneBody">
            <div className="autotuneCards">
              <div className="metric">
                <div className="metricLabel">Phase</div>
                <div className="metricValue phaseValue">{autotune.phase ?? "bereit"}</div>
                <div className="metricSub">{autotune.message ?? "Autotune bereit"}</div>
              </div>
              <Metric label="Ausgang" value={Number(autotune.output_percent ?? pumpCommand)} unit="%" sub={`AO ${(Number(autotune.output_percent ?? pumpCommand) / 10).toFixed(2)} V`} />
              <Metric label="Füllstand" value={plant.level} unit="%" sub={`${autotuneStartLevel.toFixed(0)} % Start · ${autotuneEndLevel.toFixed(0)} % Ende`} />
              <Metric label="Durchfluss" value={plant.flow} unit="%" sub={`Schwelle ${flowStartThreshold.toFixed(1)} %`} />
            </div>
            <div className="autotuneProgress">
              <span style={{ width: `${clamp(((autotune.elapsed_s ?? 0) / 180) * 100, 0, 100)}%` }} />
            </div>
            <div className="autotuneSplit">
              <div className="autotuneTable">
                <h3>Kennlinie</h3>
                <div className="tableHead"><span>Stellgröße</span><span>Durchfluss</span><span>Level</span></div>
                {(autotune.curve ?? []).slice(-12).map((point, index) => (
                  <div className="tableRow" key={`${point.output}-${index}`}>
                    <span>{point.output.toFixed(0)} %</span>
                    <span>{point.flow.toFixed(1)} %</span>
                    <span>{point.level.toFixed(1)} %</span>
                  </div>
                ))}
                {autotune.flow_threshold_output != null ? <p>Erster nutzbarer Durchfluss ab {Number(autotune.flow_threshold_output).toFixed(0)} % Stellgröße.</p> : <p>Noch kein nutzbarer Durchfluss gefunden.</p>}
              </div>
              <div className="autotuneTable">
                <h3>Sprungantwort</h3>
                <div className="tableHead"><span>t</span><span>Level</span><span>Flow</span></div>
                {(autotune.response ?? []).slice(-12).map((point, index) => (
                  <div className="tableRow" key={`${point.t}-${index}`}>
                    <span>{point.t.toFixed(1)} s</span>
                    <span>{point.level.toFixed(1)} %</span>
                    <span>{point.flow.toFixed(1)} %</span>
                  </div>
                ))}
                {autotune.status === "done" ? (
                  <p>Totzeit {Number(autotune.deadtime_s ?? 0).toFixed(1)} s, Steigung {Number(autotune.max_slope_percent_s ?? 0).toFixed(2)} %/s, Kp {Number(autotune.kp ?? 0).toFixed(2)}, Ki {Number(autotune.ki ?? 0).toFixed(3)}, Kd {Number(autotune.kd ?? 0).toFixed(2)}.</p>
                ) : <p>Nach dem Entleeren wird mit voller Pumpe bis zum Endlevel gefüllt.</p>}
              </div>
            </div>
          </div>
        </div>
      </div>
    ) : null}
    {infoOpen ? (
      <div className="infoOverlay" role="dialog" aria-modal="true">
        <div className="infoPanel">
          <div className="infoHeader">
            <div>
              <h2>Steuerung</h2>
              <span>EduKit PA Wasserstandsregelung</span>
            </div>
            <button onClick={() => setInfoOpen(false)}>Schließen</button>
          </div>
          <div className="infoContent">
            <section>
              <h3>Signalweg</h3>
              <p>Die Pumpe wird analog über DO2, DO3 und AO0 betrieben. DO2 aktiviert den Analogpfad, DO3 ist der Pumpen-Enable und AO0 gibt den Stellwert von 0 bis 10 V aus.</p>
            </section>
            <section>
              <h3>Betrieb</h3>
              <p>Es gibt nur drei Betriebsarten: Manuell für direkte Tasterbedienung, 3 Punkt für Ein/Aus-Regelung mit Toleranzband und PID für stetige Pumpenregelung.</p>
            </section>
            <section>
              <h3>Manuell</h3>
              <p>Die Taster halten Pumpe oder Ventil nur solange gedrückt wird. Beim Loslassen wird das Stellglied wieder ausgeschaltet.</p>
            </section>
            <section>
              <h3>Regler</h3>
              <p>Der Sollwert wird erst nach Übernehmen gesetzt. Toleranz, Mindest-Pumpe, Mindestdurchfluss und Max-Pumpe begrenzen die Stellgröße. Kp, Ki und Kd sind die einzigen sichtbaren Reglerparameter.</p>
            </section>
            <section>
              <h3>Mindestwerte</h3>
              <p>Wenn der Regler fördern muss, wird eine zu kleine positive Pumpenstellgröße auf die Mindest-Pumpe angehoben. Der Mindestdurchfluss hilft zu erkennen, ob wirklich Wasser ankommt.</p>
            </section>
            <section>
              <h3>Autotune</h3>
              <p>Autotune liegt oben im Header. Währenddessen wird zuerst die Pumpenkennlinie gesucht, dann der Tank entleert und anschließend mit voller Pumpe eine Sprungantwort aufgezeichnet.</p>
            </section>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function Metric({ label, value, unit, sub }: { label: string; value: number; unit: string; sub: string }) {
  return (
    <div className="metric">
      <div className="metricLabel">{label}</div>
      <div className="metricValue">{value.toFixed(1)} {unit}</div>
      <div className="metricSub">{sub}</div>
    </div>
  );
}

function NumberField({
  inputName,
  label,
  value,
  step,
  onChange
}: {
  inputName?: string;
  label: string;
  value: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(formatInputValue(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(formatInputValue(value));
  }, [focused, value]);

  function commit() {
    if (draft.trim() === "") {
      setDraft(formatInputValue(value));
      return;
    }
    const next = Number(draft);
    if (Number.isFinite(next)) {
      onChange(next);
      setDraft(formatInputValue(next));
    } else {
      setDraft(formatInputValue(value));
    }
  }

  return (
    <label className="field">
      {label}
      <input
        name={inputName ? `regler-${inputName}` : undefined}
        type="number"
        value={draft}
        step={step}
        onFocus={() => setFocused(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function ApplyNumberField({
  inputName,
  label,
  value,
  step,
  onApply
}: {
  inputName?: string;
  label: string;
  value: number;
  step: number;
  onApply: (value: number) => void;
}) {
  const [draft, setDraft] = useState(formatInputValue(value));

  useEffect(() => {
    setDraft(formatInputValue(value));
  }, [value]);

  function apply() {
    if (draft.trim() === "") {
      setDraft(formatInputValue(value));
      return;
    }
    const next = Number(draft);
    if (Number.isFinite(next)) {
      onApply(next);
      setDraft(formatInputValue(next));
    } else {
      setDraft(formatInputValue(value));
    }
  }

  return (
    <label className="field applyField">
      {label}
      <span className="applyInput">
        <input
          name={inputName ? `regler-${inputName}` : undefined}
          type="number"
          value={draft}
          step={step}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") apply();
          }}
        />
        <button type="button" className="primary" onClick={apply}>Übernehmen</button>
      </span>
    </label>
  );
}

function TrendChart({
  samples,
  compareRuns
}: {
  samples: Sample[];
  compareRuns: { name: string; samples: Sample[] }[];
}) {
  const width = 980;
  const height = 700;
  const pad = 18;
  const t0 = samples[0]?.t ?? 0;
  const t1 = samples[samples.length - 1]?.t ?? 1;
  const span = Math.max(1, t1 - t0);

  function pathFor(data: Sample[], key: keyof Pick<Sample, "level" | "flow" | "pressure" | "duty">) {
    if (data.length < 2) return "";
    const base = data[0].t;
    const end = data[data.length - 1].t;
    const localSpan = Math.max(1, end - base);
    return data
      .map((point, index) => {
        const x = pad + ((point.t - base) / localSpan) * (width - pad * 2);
        const normalized = key === "duty" ? 50 + clamp(point[key], -100, 100) / 2 : clamp(point[key], 0, 100);
        const y = pad + (1 - normalized / 100) * (height - pad * 2);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  const setpointPath =
    samples.length > 1
      ? `M${pad},${pad + (1 - samples[samples.length - 1].setpoint / 100) * (height - pad * 2)} L${width - pad},${pad + (1 - samples[samples.length - 1].setpoint / 100) * (height - pad * 2)}`
      : "";

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img">
      <rect x={pad} y={pad} width={width - pad * 2} height={height - pad * 2} rx="14" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" />
      {[0, 25, 50, 75, 100].map((tick) => {
        const y = pad + (1 - tick / 100) * (height - pad * 2);
        return (
          <g key={tick}>
            <line x1={pad} x2={width - pad} y1={y} y2={y} stroke="rgba(255,255,255,0.08)" />
            <text x="6" y={y + 4} fontSize="12" fill="#8ea0b8">{tick}%</text>
          </g>
        );
      })}
      <path d={setpointPath} fill="none" stroke="#98a2b3" strokeWidth="2" strokeDasharray="8 7" />
      {compareRuns.map((run, index) => (
        <path key={`${run.name}-${index}`} d={pathFor(run.samples, "level")} fill="none" stroke={colors.compare} strokeWidth="2" opacity={0.35 + index * 0.16} />
      ))}
      <path d={pathFor(samples, "flow")} fill="none" stroke={colors.flow} strokeWidth="2.4" />
      <path d={pathFor(samples, "pressure")} fill="none" stroke={colors.pressure} strokeWidth="2.4" />
      <path d={pathFor(samples, "duty")} fill="none" stroke={colors.duty} strokeWidth="2.2" />
      <path d={pathFor(samples, "level")} fill="none" stroke={colors.level} strokeWidth="3.4" />
      <text x={width - 110} y={height - 10} fontSize="12" fill="#8ea0b8">{span.toFixed(0)} s</text>
    </svg>
  );
}

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

function formatInputValue(value: number) {
  return Number.isFinite(value) ? String(value) : "";
}

function readReglerInput(name: string, fallback: number) {
  const input = document.querySelector<HTMLInputElement>(`input[name="regler-${name}"]`);
  if (!input || input.value.trim() === "") return fallback;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function smooth(current: number, target: number, factor: number) {
  return current + (target - current) * factor;
}
