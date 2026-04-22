"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Mode = "manual" | "auto";

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
  config: {
    level_empty_raw: number;
    level_full_raw: number;
    level_tolerance_percent: number;
    pump_overfill_percent: number;
    valve_tap_band_percent: number;
    valve_tap_s: number;
    valve_tap_pause_s: number;
    valve_fine_band_percent: number;
    valve_fine_tap_s: number;
    valve_fine_tap_pause_s: number;
    actuator_pause_s: number;
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

const controlApi = process.env.NEXT_PUBLIC_CONTROL_API ?? "http://127.0.0.1:8080";
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
  const [controlAction, setControlAction] = useState("idle");
  const [levelTolerance, setLevelTolerance] = useState(3);
  const [pumpOverfill, setPumpOverfill] = useState(1);
  const [valveTapBand, setValveTapBand] = useState(5);
  const [valveTap, setValveTap] = useState(0.4);
  const [valveTapPause, setValveTapPause] = useState(1.8);
  const [valveFineBand, setValveFineBand] = useState(2);
  const [valveFineTap, setValveFineTap] = useState(0.15);
  const [valveFineTapPause, setValveFineTapPause] = useState(1.2);
  const [actuatorPause, setActuatorPause] = useState(1.5);
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
    simRef.current.previousError = error;
    if (error > levelTolerance) return 100;
    if (error < -levelTolerance) return -100;
    return 0;
  }, [liveConnected, liveDuty, mode, manualDuty, pid.setpoint, plant.level, levelTolerance]);

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
        const valveDuty = Math.max(0, -duty);
        const inflow = pumpDuty * 0.055;
        const outflow = 1.15 + current.level * 0.012 + valveDuty * 0.05;
        const nextLevel = clamp(current.level + (inflow - outflow) * 0.2, 0, 100);
        const nextFlow = smooth(current.flow, duty * 0.92 + Math.random() * 2.5, 0.28);
        const nextPressure = smooth(current.pressure, 5 + duty * 0.21 + Math.random() * 1.5, 0.22);
        const pumpOn = pumpDuty > 1;
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
  }, [activeDuty, liveConnected, manualDuty, mode, pid.setpoint]);

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
        setControlAction(state.control_action);
        setLevelTolerance(state.config.level_tolerance_percent);
        setPumpOverfill(state.config.pump_overfill_percent);
        setValveTapBand(state.config.valve_tap_band_percent);
        setValveTap(state.config.valve_tap_s);
        setValveTapPause(state.config.valve_tap_pause_s);
        setValveFineBand(state.config.valve_fine_band_percent);
        setValveFineTap(state.config.valve_fine_tap_s);
        setValveFineTapPause(state.config.valve_fine_tap_pause_s);
        setActuatorPause(state.config.actuator_pause_s);
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
      pump_overfill_percent: pumpOverfill,
      valve_tap_band_percent: valveTapBand,
      valve_tap_s: valveTap,
      valve_tap_pause_s: valveTapPause,
      valve_fine_band_percent: valveFineBand,
      valve_fine_tap_s: valveFineTap,
      valve_fine_tap_pause_s: valveFineTapPause,
      actuator_pause_s: actuatorPause
    });
  }

  function updateControlTuning(key: "pump_overfill_percent" | "valve_tap_band_percent" | "valve_tap_s" | "valve_tap_pause_s" | "valve_fine_band_percent" | "valve_fine_tap_s" | "valve_fine_tap_pause_s" | "actuator_pause_s", value: number) {
    const nextPumpOverfill = key === "pump_overfill_percent" ? clamp(value, 0, 10) : pumpOverfill;
    const nextValveTapBand = key === "valve_tap_band_percent" ? clamp(value, 0.5, 30) : valveTapBand;
    const nextValveTap = key === "valve_tap_s" ? clamp(value, 0.05, 5) : valveTap;
    const nextValvePause = key === "valve_tap_pause_s" ? clamp(value, 0, 20) : valveTapPause;
    const nextFineBand = key === "valve_fine_band_percent" ? clamp(value, 0.2, 20) : valveFineBand;
    const nextFineTap = key === "valve_fine_tap_s" ? clamp(value, 0.03, 2) : valveFineTap;
    const nextFinePause = key === "valve_fine_tap_pause_s" ? clamp(value, 0, 20) : valveFineTapPause;
    const nextPause = key === "actuator_pause_s" ? clamp(value, 0, 20) : actuatorPause;
    setPumpOverfill(nextPumpOverfill);
    setValveTapBand(nextValveTapBand);
    setValveTap(nextValveTap);
    setValveTapPause(nextValvePause);
    setValveFineBand(nextFineBand);
    setValveFineTap(nextFineTap);
    setValveFineTapPause(nextFinePause);
    setActuatorPause(nextPause);
    postControl("/api/config", {
      level_tolerance_percent: levelTolerance,
      pump_overfill_percent: nextPumpOverfill,
      valve_tap_band_percent: nextValveTapBand,
      valve_tap_s: nextValveTap,
      valve_tap_pause_s: nextValvePause,
      valve_fine_band_percent: nextFineBand,
      valve_fine_tap_s: nextFineTap,
      valve_fine_tap_pause_s: nextFinePause,
      actuator_pause_s: nextPause
    });
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

  function setManualOutput(value: number) {
    setManualDuty(value);
    postControl("/api/manual", { duty: value });
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
            {mode === "auto" ? "Auto Impuls" : "Manuell"} · Pumpe {plant.pumpOn ? "AN" : "AUS"} · Ventil {plant.drainValveOn ? "AUF" : "ZU"}
          </span>
          <span className={`statusPill ${liveConnected && !backendError ? "live" : "warn"}`}>
            {liveConnected && !backendError ? "Live verbunden" : "Offline"}
          </span>
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
                <span className="muted">Impulssteuerung und Modus</span>
              </div>
              <span className={`chip ${plant.pumpOn ? "on" : ""}`}>{plant.pumpOn ? "aktiv" : "bereit"}</span>
            </div>
            <div className="segmented">
              <button className={mode === "manual" ? "active" : ""} onClick={() => setControlMode("manual")}>Manuell</button>
              <button className={mode === "auto" ? "active" : ""} onClick={() => setControlMode("auto")}>Auto Impuls</button>
            </div>
            <label className="field wide" style={{ marginTop: 14 }}>
              Manuelle PWM-Leistung {manualDuty.toFixed(0)} %
              <input
                type="range"
                min={0}
                max={100}
                value={manualDuty}
                onChange={(event) => setManualOutput(Number(event.target.value))}
              />
            </label>
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
            {mode === "auto" ? (
              <div className="pulseStatus">
                {controlAction === "pump"
                  ? "Pumpe füllt grob über Sollwert"
                  : controlAction === "valve_tap"
                    ? "Ventil korrigiert kurz"
                    : controlAction === "valve_fine_tap"
                      ? "Ventil korrigiert fein"
                    : controlAction === "valve_fast"
                      ? "Ventil lässt schnell ab"
                    : "Im Toleranzband"}
              </div>
            ) : null}
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
                <span className="muted">Sollwert und Impulse</span>
              </div>
              <span className="chip">{activeDuty >= 0 ? "+" : ""}{activeDuty.toFixed(1)} %</span>
            </div>
            <div className="simpleControl">
              <NumberField label="Sollwert %" value={pid.setpoint} step={1} onChange={(value) => updatePid("setpoint", value)} />
              <NumberField label="Toleranz %" value={levelTolerance} step={0.5} onChange={updateTolerance} />
              <div className="regulatorSummary">
                <span>Istwert</span>
                <strong>{plant.level.toFixed(1)} %</strong>
                <span>Abweichung</span>
                <strong>{(pid.setpoint - plant.level).toFixed(1)} %</strong>
              </div>
            </div>
            <details className="expertPanel regulatorExpert">
              <summary>Reglerdetails</summary>
              <div className="formGrid">
                <label className="field wide">
                  Template
                  <select value={selectedTemplateId} onChange={(event) => loadTemplate(templates.find((item) => item.id === event.target.value) ?? templates[0])}>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>{template.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field wide">
                  Name
                  <input value={selectedTemplate?.name ?? ""} onChange={(event) => renameTemplate(event.target.value)} />
                </label>
                <NumberField label="Kp" value={pid.kp} step={0.1} onChange={(value) => updatePid("kp", value)} />
                <NumberField label="Ki" value={pid.ki} step={0.005} onChange={(value) => updatePid("ki", value)} />
                <NumberField label="Kd" value={pid.kd} step={0.05} onChange={(value) => updatePid("kd", value)} />
                <NumberField label="Über Toleranz füllen %" value={pumpOverfill} step={0.2} onChange={(value) => updateControlTuning("pump_overfill_percent", value)} />
                <NumberField label="Tap-Bereich %" value={valveTapBand} step={0.5} onChange={(value) => updateControlTuning("valve_tap_band_percent", value)} />
                <NumberField label="Ventil-Tap s" value={valveTap} step={0.05} onChange={(value) => updateControlTuning("valve_tap_s", value)} />
                <NumberField label="Pause nach Tap s" value={valveTapPause} step={0.2} onChange={(value) => updateControlTuning("valve_tap_pause_s", value)} />
                <NumberField label="Fein-Bereich %" value={valveFineBand} step={0.2} onChange={(value) => updateControlTuning("valve_fine_band_percent", value)} />
                <NumberField label="Fein-Tap s" value={valveFineTap} step={0.02} onChange={(value) => updateControlTuning("valve_fine_tap_s", value)} />
                <NumberField label="Pause nach Fein-Tap s" value={valveFineTapPause} step={0.2} onChange={(value) => updateControlTuning("valve_fine_tap_pause_s", value)} />
                <NumberField label="Pause nach Pumpe s" value={actuatorPause} step={0.5} onChange={(value) => updateControlTuning("actuator_pause_s", value)} />
                <button className="primary" onClick={updateTemplate}>Speichern</button>
                <button onClick={saveTemplate}>Als Vorlage</button>
              </div>
              <div className="drawerGrid">
                <div>
                  <div className="miniTitle">Templates</div>
                  <div className="templateList embedded">
                    {templates.map((template) => (
                      <button
                        className={`templateButton ${template.id === selectedTemplateId ? "active" : ""}`}
                        key={template.id}
                        onClick={() => loadTemplate(template)}
                      >
                        <strong>{template.name}</strong>
                        <span>Kp {template.kp} · Ki {template.ki} · Kd {template.kd}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="miniTitle">Vergleiche</div>
                  <div className="templateList embedded">
                    {compareRuns.length === 0 ? <span className="emptyState">Noch kein Lauf</span> : null}
                    {compareRuns.map((run, index) => (
                      <button
                        className="templateButton"
                        key={`${run.name}-${index}`}
                        onClick={() => setCompareRuns((runs) => runs.filter((_, i) => i !== index))}
                      >
                        <strong>{run.name}</strong>
                        <span>{run.samples.length} Punkte · entfernen</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </details>
          </div>
        </aside>

        <section className="column">
          <div className="metricGrid">
            <Metric label="Füllstand AI1" value={plant.level} unit="%" sub={`raw ${plant.levelRaw} · ${plant.levelVoltage.toFixed(3)} V · ${pid.setpoint.toFixed(0)} % Soll`} />
            <Metric label="Durchfluss AI2" value={plant.flow} unit="%" sub={liveConnected ? `raw ${plant.flowRaw} · ${plant.flowVoltage.toFixed(3)} V` : "Mock-Skalierung"} />
            <Metric label="Druck AI3" value={plant.pressure} unit="%" sub={liveConnected ? `raw ${plant.pressureRaw} · ${plant.pressureVoltage.toFixed(3)} V` : "Mock-Skalierung"} />
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
                  <div className={`pump ${plant.pumpOn ? "on" : ""}`} title={`Pumpe DO3: ${plant.pumpOn ? "AN" : "AUS"} · Impuls ${Math.max(0, activeDuty).toFixed(1)} %`}><div className="pumpIcon" /></div>
                  <span className="pipeLabel">DO3</span>
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
  label,
  value,
  step,
  onChange
}: {
  label: string;
  value: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      {label}
      <input type="number" value={value} step={step} onChange={(event) => onChange(Number(event.target.value))} />
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

function smooth(current: number, target: number, factor: number) {
  return current + (target - current) * factor;
}
