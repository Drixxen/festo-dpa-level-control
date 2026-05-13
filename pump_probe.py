from __future__ import annotations

import argparse
import time
from dataclasses import dataclass

from easyport import EasyPort, EasyPortError, format_ports, list_serial_ports, raw_to_voltage
from edukit_pa import EduKitConfig


@dataclass(frozen=True)
class ProbeConfig:
    port: str
    address: int
    percent: float
    seconds: float


def percent_to_raw(percent: float) -> int:
    clamped = max(0.0, min(100.0, percent))
    return round(clamped / 100.0 * 0x7FF8)


def print_snapshot(easyport: EasyPort) -> None:
    digital_inputs = easyport.read_digital_inputs_word()
    digital_outputs = easyport.read_digital_outputs_word()
    ao0 = easyport.read_analog_output_raw(0)
    ao1 = easyport.read_analog_output_raw(1)
    print(f"DI word:  0x{digital_inputs:04X}  bits={bits(digital_inputs)}")
    print(f"DO word:  0x{digital_outputs:04X}  bits={bits(digital_outputs)}")
    print(f"AO0:      raw={ao0:5d}  {raw_to_voltage(ao0):.3f} V")
    print(f"AO1:      raw={ao1:5d}  {raw_to_voltage(ao1):.3f} V")


def read_state(easyport: EasyPort) -> tuple[int, int, int, int]:
    return (
        easyport.read_digital_inputs_word(),
        easyport.read_digital_outputs_word(),
        easyport.read_analog_output_raw(0),
        easyport.read_analog_output_raw(1),
    )


def format_state(state: tuple[int, int, int, int]) -> str:
    digital_inputs, digital_outputs, ao0, ao1 = state
    return (
        f"DI=0x{digital_inputs:04X}({bits(digital_inputs)})  "
        f"DO=0x{digital_outputs:04X}({bits(digital_outputs)})  "
        f"AO0={raw_to_voltage(ao0):5.2f}V/{ao0:5d}  "
        f"AO1={raw_to_voltage(ao1):5.2f}V/{ao1:5d}"
    )


def bits(value: int) -> str:
    enabled = [str(bit) for bit in range(16) if value & (1 << bit)]
    return ",".join(enabled) if enabled else "-"


def all_outputs_off(easyport: EasyPort) -> None:
    for channel in (0, 1):
        try:
            easyport.write_analog_output_raw(channel, 0)
        except EasyPortError as exc:
            print(f"Warnung: AO{channel} konnte nicht auf 0 gesetzt werden: {exc}")
    try:
        easyport.write_digital_outputs_word(0)
    except EasyPortError as exc:
        print(f"Warnung: DO-Wort konnte nicht auf 0 gesetzt werden: {exc}")


def run_analog(easyport: EasyPort, channel: int, percent: float, seconds: float) -> None:
    raw = percent_to_raw(percent)
    print(f"Teste AO{channel}: {percent:.1f}% -> raw {raw} ({raw_to_voltage(raw):.3f} V)")
    easyport.write_analog_output_raw(channel, raw)
    time.sleep(seconds)
    easyport.write_analog_output_raw(channel, 0)
    print("AO wieder auf 0 gesetzt.")


def run_digital(easyport: EasyPort, bit: int, seconds: float) -> None:
    print(f"Teste DO{bit}: EIN fuer {seconds:.1f}s")
    easyport.set_digital_output(bit, True)
    time.sleep(seconds)
    easyport.set_digital_output(bit, False)
    print(f"DO{bit} wieder AUS.")


def run_combo(easyport: EasyPort, bit: int, bit_state: bool, channel: int, percent: float, seconds: float) -> None:
    raw = percent_to_raw(percent)
    state_text = "EIN" if bit_state else "AUS"
    print(
        f"Teste Kombi: DO{bit}={state_text}, AO{channel}={percent:.1f}% "
        f"({raw_to_voltage(raw):.3f} V) fuer {seconds:.1f}s"
    )
    easyport.set_digital_output(bit, bit_state)
    easyport.write_analog_output_raw(channel, raw)
    time.sleep(seconds)
    easyport.write_analog_output_raw(channel, 0)
    easyport.set_digital_output(bit, False)
    print("Kombi wieder auf 0/AUS gesetzt.")


def hold_analog(easyport: EasyPort, channel: int, percent: float) -> None:
    raw = percent_to_raw(percent)
    print(f"HALTE AO{channel}: {percent:.1f}% -> raw {raw} ({raw_to_voltage(raw):.3f} V)")
    easyport.write_analog_output_raw(channel, raw)
    print_snapshot(easyport)
    input("Pruefen/messen/hoeren, dann Enter zum Ausschalten...")
    easyport.write_analog_output_raw(channel, 0)
    print("AO wieder auf 0 gesetzt.")


def hold_digital(easyport: EasyPort, bit: int) -> None:
    print(f"HALTE DO{bit}: EIN")
    easyport.set_digital_output(bit, True)
    print_snapshot(easyport)
    input("Pruefen/messen/hoeren, dann Enter zum Ausschalten...")
    easyport.set_digital_output(bit, False)
    print(f"DO{bit} wieder AUS.")


def hold_combo(easyport: EasyPort, bit: int, bit_state: bool, channel: int, percent: float) -> None:
    raw = percent_to_raw(percent)
    state_text = "EIN" if bit_state else "AUS"
    print(f"HALTE DO{bit}={state_text}, AO{channel}={percent:.1f}% ({raw_to_voltage(raw):.3f} V)")
    easyport.set_digital_output(bit, bit_state)
    easyport.write_analog_output_raw(channel, raw)
    print_snapshot(easyport)
    input("Pruefen/messen/hoeren, dann Enter zum Ausschalten...")
    easyport.write_analog_output_raw(channel, 0)
    easyport.set_digital_output(bit, False)
    print("Kombi wieder auf 0/AUS gesetzt.")


def hold_mask(easyport: EasyPort, mask: int, channel: int | None, percent: float) -> None:
    if not 0 <= mask <= 0xFFFF:
        raise ValueError("DO mask must be in range 0x0000..0xFFFF")
    raw = percent_to_raw(percent)
    print(f"HALTE DO-Maske 0x{mask:04X} bits={bits(mask)}")
    easyport.write_digital_outputs_word(mask)
    if channel is not None:
        print(f"HALTE AO{channel}: {percent:.1f}% ({raw_to_voltage(raw):.3f} V)")
        easyport.write_analog_output_raw(channel, raw)
    print_snapshot(easyport)
    input("Pruefen/messen/hoeren, dann Enter zum Ausschalten...")
    if channel is not None:
        easyport.write_analog_output_raw(channel, 0)
    easyport.write_digital_outputs_word(0)
    print("Maske/AO wieder auf 0 gesetzt.")


def run_mask_matrix(easyport: EasyPort, base_mask: int, channel: int, percent: float) -> None:
    print(f"Masken-Matrix: Basis 0x{base_mask:04X} bits={bits(base_mask)}, AO{channel}={percent:.1f}%")
    print("Getestet wird: Basis alleine, dann Basis + je ein weiteres DO-Bit.")
    print("Enter startet den naechsten Kandidaten. Notiert, wenn Drehzahl/Durchfluss analog reagiert.")
    candidates = [base_mask]
    for bit in range(8):
        candidates.append(base_mask | (1 << bit))
    seen: set[int] = set()
    ordered = [mask for mask in candidates if not (mask in seen or seen.add(mask))]
    for index, mask in enumerate(ordered, start=1):
        input(f"\n[{index:02d}/{len(ordered):02d}] DO=0x{mask:04X} bits={bits(mask)}, AO{channel}. Enter...")
        hold_mask(easyport, mask, channel, percent)


def run_ramp(easyport: EasyPort, enable_bit: int, channel: int, seconds: float) -> None:
    print(f"Rampen-Test: DO{enable_bit}=EIN, AO{channel}=0/20/40/60/80%")
    print("Wenn die Pumpe analog reagiert, sollte sich Geraeusch/Durchfluss mit den Stufen aendern.")
    easyport.write_analog_output_raw(channel, 0)
    easyport.set_digital_output(enable_bit, True)
    try:
        for percent in (0, 20, 40, 60, 80):
            raw = percent_to_raw(percent)
            print(f"AO{channel} = {percent:>2}% ({raw_to_voltage(raw):.3f} V)")
            easyport.write_analog_output_raw(channel, raw)
            print_snapshot(easyport)
            time.sleep(seconds)
    finally:
        easyport.write_analog_output_raw(channel, 0)
        easyport.set_digital_output(enable_bit, False)
        print("Rampe beendet, AO und Enable aus.")


def run_mask_ramp(
    easyport: EasyPort,
    mask: int,
    channel: int,
    seconds: float,
    start: int,
    stop: int,
    step: int,
) -> None:
    if step <= 0:
        raise ValueError("step must be positive")
    if not 0 <= mask <= 0xFFFF:
        raise ValueError("DO mask must be in range 0x0000..0xFFFF")
    print(f"Masken-Rampe: DO=0x{mask:04X} bits={bits(mask)}, AO{channel}={start}..{stop}%")
    print("Ctrl+C bricht ab. Danach setzt das Script AO und DO auf 0.")
    easyport.write_analog_output_raw(channel, 0)
    easyport.write_digital_outputs_word(mask)
    try:
        for percent in range(start, stop + 1, step):
            raw = percent_to_raw(percent)
            print(f"AO{channel} = {percent:>3}%  {raw_to_voltage(raw):5.2f} V  raw={raw:5d}")
            easyport.write_analog_output_raw(channel, raw)
            time.sleep(seconds)
    finally:
        easyport.write_analog_output_raw(channel, 0)
        easyport.write_digital_outputs_word(0)
        print("Rampe beendet, AO und DO aus.")


def watch_outputs(easyport: EasyPort, interval: float) -> None:
    print("Live-Watch. Jetzt in der Festo-Anwendung Schalter/Stellwert aendern.")
    print("Ctrl+C beendet den Watch-Modus. Es werden keine Ausgaenge geschrieben.")
    previous: tuple[int, int, int, int] | None = None
    try:
        while True:
            state = read_state(easyport)
            if state != previous:
                print(time.strftime("%H:%M:%S"), format_state(state))
                previous = state
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nWatch beendet.")


def run_sweep(easyport: EasyPort, percent: float, seconds: float, pause: float) -> None:
    print("Starte sicheren Pumpen-Sweep. Beobachtet: Laeuft die Pumpe? Wenn ja: notiert Zeile.")
    print("Abbruch jederzeit mit Ctrl+C. Danach setzt das Script alle Ausgaenge auf 0.")
    tests: list[tuple[str, callable]] = []

    for channel in (0, 1):
        tests.append((f"AO{channel} direkt", lambda ch=channel: run_analog(easyport, ch, percent, seconds)))

    for bit in range(8):
        tests.append((f"DO{bit} direkt", lambda b=bit: run_digital(easyport, b, seconds)))

    for channel in (0, 1):
        for bit in range(8):
            tests.append(
                (
                    f"DO{bit}=AUS + AO{channel}",
                    lambda b=bit, ch=channel: run_combo(easyport, b, False, ch, percent, seconds),
                )
            )
            tests.append(
                (
                    f"DO{bit}=EIN + AO{channel}",
                    lambda b=bit, ch=channel: run_combo(easyport, b, True, ch, percent, seconds),
                )
            )

    for index, (name, test) in enumerate(tests, start=1):
        print(f"\n[{index:02d}/{len(tests):02d}] {name}")
        all_outputs_off(easyport)
        time.sleep(pause)


def run_sequence(easyport: EasyPort, percent: float, seconds: float) -> None:
    tests: list[tuple[str, callable]] = [
        ("AO0 analog", lambda: run_analog(easyport, 0, percent, seconds)),
        ("AO1 analog", lambda: run_analog(easyport, 1, percent, seconds)),
        ("DO2 digital", lambda: run_digital(easyport, 2, seconds)),
        ("DO3 digital", lambda: run_digital(easyport, 3, seconds)),
        ("DO2 EIN + AO0", lambda: run_combo(easyport, 2, True, 0, percent, seconds)),
        ("DO2 AUS + AO0", lambda: run_combo(easyport, 2, False, 0, percent, seconds)),
        ("DO3 EIN + AO0", lambda: run_combo(easyport, 3, True, 0, percent, seconds)),
        ("DO3 AUS + AO0", lambda: run_combo(easyport, 3, False, 0, percent, seconds)),
        ("DO2 EIN + AO1", lambda: run_combo(easyport, 2, True, 1, percent, seconds)),
        ("DO2 AUS + AO1", lambda: run_combo(easyport, 2, False, 1, percent, seconds)),
        ("DO3 EIN + AO1", lambda: run_combo(easyport, 3, True, 1, percent, seconds)),
        ("DO3 AUS + AO1", lambda: run_combo(easyport, 3, False, 1, percent, seconds)),
    ]

    print("Interaktive Sequenz. Nach jedem Test bitte notieren, ob die Pumpe lief.")
    print("Enter startet den naechsten Test, Ctrl+C bricht ab und setzt Ausgaenge auf 0.")
    all_outputs_off(easyport)
    for index, (name, test) in enumerate(tests, start=1):
        input(f"\n[{index:02d}/{len(tests):02d}] Bereit fuer {name}? Enter...")
        all_outputs_off(easyport)
        print("Vorher:")
        print_snapshot(easyport)
        test()
        print("Nachher:")
        print_snapshot(easyport)
        all_outputs_off(easyport)
        test()
        all_outputs_off(easyport)
        time.sleep(pause)


def open_easyport(args: argparse.Namespace) -> EasyPort:
    loaded = EduKitConfig.load(args.config)
    port = args.port or loaded.port
    return EasyPort(port, address=args.address or loaded.address)


def main() -> None:
    parser = argparse.ArgumentParser(description="Direkter Pumpen-Test fuer Festo EasyPort ohne Dashboard-Regelkreis.")
    parser.add_argument("--config", default="edukit_config.json")
    parser.add_argument("--port", default=None)
    parser.add_argument("--address", type=int, default=None)
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("ports", help="Serielle Ports anzeigen")
    subparsers.add_parser("snapshot", help="DI/DO/AO-Zustand lesen")
    watch = subparsers.add_parser("watch", help="DI/DO/AO live beobachten, ohne zu schreiben")
    watch.add_argument("--interval", type=float, default=0.2)
    subparsers.add_parser("off", help="Alle DO und AO auf 0 setzen")

    analog = subparsers.add_parser("analog", help="Einen Analogausgang kurz setzen")
    analog.add_argument("--channel", type=int, choices=(0, 1), required=True)
    analog.add_argument("--percent", type=float, default=25.0)
    analog.add_argument("--seconds", type=float, default=3.0)

    digital = subparsers.add_parser("digital", help="Einen Digitalausgang kurz einschalten")
    digital.add_argument("--bit", type=int, choices=range(16), required=True)
    digital.add_argument("--seconds", type=float, default=2.0)

    combo = subparsers.add_parser("combo", help="Ein DO-Bit mit einem AO-Signal kombinieren")
    combo.add_argument("--bit", type=int, choices=range(16), required=True)
    combo.add_argument("--bit-state", choices=("on", "off"), required=True)
    combo.add_argument("--channel", type=int, choices=(0, 1), required=True)
    combo.add_argument("--percent", type=float, default=25.0)
    combo.add_argument("--seconds", type=float, default=3.0)

    hold = subparsers.add_parser("hold", help="Ausgang setzen und bis Enter halten")
    hold_subparsers = hold.add_subparsers(dest="hold_command", required=True)
    hold_analog_parser = hold_subparsers.add_parser("analog")
    hold_analog_parser.add_argument("--channel", type=int, choices=(0, 1), required=True)
    hold_analog_parser.add_argument("--percent", type=float, default=70.0)
    hold_digital_parser = hold_subparsers.add_parser("digital")
    hold_digital_parser.add_argument("--bit", type=int, choices=range(16), required=True)
    hold_combo_parser = hold_subparsers.add_parser("combo")
    hold_combo_parser.add_argument("--bit", type=int, choices=range(16), required=True)
    hold_combo_parser.add_argument("--bit-state", choices=("on", "off"), required=True)
    hold_combo_parser.add_argument("--channel", type=int, choices=(0, 1), required=True)
    hold_combo_parser.add_argument("--percent", type=float, default=70.0)
    hold_mask_parser = hold_subparsers.add_parser("mask")
    hold_mask_parser.add_argument("--mask", required=True, help="Digitalausgangs-Wort, z.B. 0x0008")
    hold_mask_parser.add_argument("--channel", type=int, choices=(0, 1), default=None)
    hold_mask_parser.add_argument("--percent", type=float, default=70.0)

    matrix = subparsers.add_parser("matrix", help="DO3 plus Zusatzbits mit AO testen")
    matrix.add_argument("--base-mask", default="0x0008", help="Basis-DO-Maske, default DO3")
    matrix.add_argument("--channel", type=int, choices=(0, 1), required=True)
    matrix.add_argument("--percent", type=float, default=70.0)

    ramp = subparsers.add_parser("ramp", help="DO-Enable halten und AO in Stufen aendern")
    ramp.add_argument("--enable-bit", type=int, choices=range(16), default=3)
    ramp.add_argument("--channel", type=int, choices=(0, 1), required=True)
    ramp.add_argument("--seconds", type=float, default=3.0)

    mask_ramp = subparsers.add_parser("mask-ramp", help="DO-Maske halten und AO bis 10V rampen")
    mask_ramp.add_argument("--mask", default="0x000C", help="Digitalausgangs-Wort, default DO2+DO3")
    mask_ramp.add_argument("--channel", type=int, choices=(0, 1), default=0)
    mask_ramp.add_argument("--seconds", type=float, default=3.0)
    mask_ramp.add_argument("--start", type=int, default=0)
    mask_ramp.add_argument("--stop", type=int, default=100)
    mask_ramp.add_argument("--step", type=int, default=10)

    sweep = subparsers.add_parser("sweep", help="AO0/AO1, DO0..DO7 und Kombinationen nacheinander testen")
    sweep.add_argument("--percent", type=float, default=25.0)
    sweep.add_argument("--seconds", type=float, default=2.0)
    sweep.add_argument("--pause", type=float, default=0.8)

    sequence = subparsers.add_parser("sequence", help="Wichtige Pumpenkandidaten einzeln mit Enter bestaetigen")
    sequence.add_argument("--percent", type=float, default=35.0)
    sequence.add_argument("--seconds", type=float, default=5.0)

    args = parser.parse_args()
    if args.command == "ports":
        print(format_ports(list_serial_ports()) or "Keine seriellen Ports gefunden.")
        return

    with open_easyport(args) as easyport:
        if args.command == "snapshot":
            print_snapshot(easyport)
        elif args.command == "watch":
            watch_outputs(easyport, args.interval)
        elif args.command == "off":
            all_outputs_off(easyport)
            print("Alle erreichbaren DO und AO auf 0 gesetzt.")
        else:
            try:
                if args.command == "analog":
                    run_analog(easyport, args.channel, args.percent, args.seconds)
                elif args.command == "digital":
                    run_digital(easyport, args.bit, args.seconds)
                elif args.command == "combo":
                    run_combo(
                        easyport,
                        args.bit,
                        args.bit_state == "on",
                        args.channel,
                        args.percent,
                        args.seconds,
                    )
                elif args.command == "sweep":
                    run_sweep(easyport, args.percent, args.seconds, args.pause)
                elif args.command == "sequence":
                    run_sequence(easyport, args.percent, args.seconds)
                elif args.command == "ramp":
                    run_ramp(easyport, args.enable_bit, args.channel, args.seconds)
                elif args.command == "mask-ramp":
                    run_mask_ramp(
                        easyport,
                        int(args.mask, 0),
                        args.channel,
                        args.seconds,
                        args.start,
                        args.stop,
                        args.step,
                    )
                elif args.command == "matrix":
                    run_mask_matrix(easyport, int(args.base_mask, 0), args.channel, args.percent)
                elif args.command == "hold":
                    if args.hold_command == "analog":
                        hold_analog(easyport, args.channel, args.percent)
                    elif args.hold_command == "digital":
                        hold_digital(easyport, args.bit)
                    elif args.hold_command == "combo":
                        hold_combo(
                            easyport,
                            args.bit,
                            args.bit_state == "on",
                            args.channel,
                            args.percent,
                        )
                    elif args.hold_command == "mask":
                        hold_mask(easyport, int(args.mask, 0), args.channel, args.percent)
            finally:
                all_outputs_off(easyport)


if __name__ == "__main__":
    main()
