# Pulsar — Arduino firmware

A small sketch that listens for `SET <id> <0|1>` commands on the serial port
and toggles four LEDs accordingly.

## Hardware

- 1× Arduino Uno R3, MKR Zero, Nano, or any board with USB serial + 4 digital
  outputs.
- 4× LEDs: red, yellow, blue, green (any color, but those map to the meanings
  the Mac side assigns).
- 4× 220Ω resistors (anything between 150Ω and 470Ω works for standard 5mm
  LEDs on 5V; if you're on a 3.3V MKR Zero, 150Ω–220Ω is fine).
- A breadboard and some jumper wires.

> **MKR Zero note:** the MKR Zero runs at 3.3V logic. Don't reuse a circuit
> designed for 5V without re-checking resistor values, and never drive an LED
> from the 5V pin through the MKR's I/O pins.

## Pin assignments

| LED color | Arduino pin | Meaning              | LED id (serial) |
|-----------|-------------|----------------------|-----------------|
| Red       | D2          | Build failing        | 0               |
| Yellow    | D3          | Review requested     | 1               |
| Blue      | D4          | New comments on PRs  | 2               |
| Green     | D5          | All clear            | 3               |

## Wiring

Each LED is wired the same way, with its own resistor and its own digital pin:

```
   Dx ───[ 220Ω ]───▶|─── GND
                    ▲ ▲
                    │ └── cathode (short leg / flat side of the plastic rim)
                    └──── anode   (long leg)
```

The `▶|` symbol is the standard schematic glyph for an LED — the triangle
points from anode to cathode, in the direction current flows.

So for the four LEDs, the connections you need to make are simply:

| From (Arduino) | through        | to (LED anode)  | LED cathode goes to |
|----------------|----------------|-----------------|---------------------|
| **D2**         | 220Ω resistor  | Red LED         | **GND**             |
| **D3**         | 220Ω resistor  | Yellow LED      | **GND**             |
| **D4**         | 220Ω resistor  | Blue LED        | **GND**             |
| **D5**         | 220Ω resistor  | Green LED       | **GND**             |

On a breadboard, the simplest setup is to plug all four LED cathodes into the
breadboard's GND rail and run a single jumper from that rail to **GND** on the
Arduino. You only need **GND** and the four **Dx** pins — the **5V**, **Vin**,
and **Vcc** pins stay unused (the digital pins themselves supply the ~5V or
~3.3V the LEDs need).

## Flashing the sketch

1. Open `led_controller/led_controller.ino` in the Arduino IDE.
2. **Tools → Board** → pick your board (Uno or MKR Zero).
3. **Tools → Port** → pick the matching `/dev/cu.usbmodem*` entry.
4. Click **Upload**.

On reset you should see the four LEDs blink in sequence (red → yellow → blue
→ green) — that's the startup self-test in `setup()`.

## Serial protocol

```
SET <id> <0|1>\n     → Arduino replies "OK\n"
```

- `<id>` is 0–3, matching the table above.
- `<0|1>` is the desired LED state.
- Baud rate: **9600**.
- Unknown commands are silently ignored.

You can test it without the Mac daemon by opening the Arduino IDE's Serial
Monitor (set to 9600 baud, "Newline" line ending) and typing:

```
SET 0 1     ← red on
SET 0 0     ← red off
SET 3 1     ← green on
```
