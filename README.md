# Festo D:PA-KIT-MSR-MAN Dashboard

React/Next.js Dashboard mit kleinem Python-API-Server fuer die Festo EasyPort-Anbindung.

## Start

Alles neu starten:

```bash
./restart_dashboard.sh
```

Danach im Browser:

```bash
http://127.0.0.1:3000
```

Die API laeuft lokal auf:

```bash
http://127.0.0.1:8080/api/state
```

## Aufbau

- `frontend/`: Next.js/React Dashboard
- `api_server.py`: schlanker API-Server fuer das Dashboard
- `control_loop.py`: Regelkreis
- `edukit_pa.py`: Festo D:PA-KIT-MSR-MAN Prozessmodell und EasyPort-I/O
- `easyport.py`: EasyPort ASCII-Protokoll
- `pid_controller.py`: Sollwertspeicher und Reglerparameter
- `edukit_config.json`: Port, I/O-Zuordnung, Kalibrierung und Filter

## Aktuelle Aktoren

- Pumpe: digital ueber `pump_bit` (`DO3` im aktuellen Aufbau)
- Ablassventil M102: digital ueber `drain_valve_bit` (`DO0` im aktuellen Aufbau)

Wenn ein Ausgang anders verdrahtet ist, zuerst `edukit_config.json` anpassen.

## Auto 3-Punkt

Der Auto-Modus ist eine hybride 3-Punkt-Regelung:

- Fuellstand zu niedrig: Pumpe DO3 fuellt grob bis ueber das obere Toleranzband
- Fuellstand im Toleranzband: alles aus
- Fuellstand weit zu hoch: Ventil M102/DO0 bleibt offen
- Fuellstand nahe am Sollwert: Ventil M102/DO0 wird in kurzen Taps geoeffnet
- Fuellstand ganz nah am Sollwert: Ventil M102/DO0 wird in sehr kurzen Feintaps geoeffnet

Die wichtigsten Parameter stehen in `edukit_config.json` und koennen im Dashboard eingestellt werden:

- `level_tolerance_percent`
- `pump_overfill_percent`
- `valve_tap_band_percent`
- `valve_tap_s`
- `valve_tap_pause_s`
- `valve_fine_band_percent`
- `valve_fine_tap_s`
- `valve_fine_tap_pause_s`
- `actuator_pause_s`

## Entwicklung

Nur Frontend starten:

```bash
cd frontend
npm run dev -- --hostname 127.0.0.1
```

Nur API starten:

```bash
python3 api_server.py
```
