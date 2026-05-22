// LED wiring:
//   Pin 2 → Red    (220Ω resistor) → GND   : build failing
//   Pin 3 → Yellow (220Ω resistor) → GND   : review requested
//   Pin 4 → Blue   (220Ω resistor) → GND   : new comments
//   Pin 5 → Green  (220Ω resistor) → GND   : all clear
//
// Protocol: "SET <id> <0|1>\n"  →  Arduino replies "OK\n"

const int LED_PINS[] = {2, 3, 4, 5};
const int NUM_LEDS = 4;

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < NUM_LEDS; i++) {
    pinMode(LED_PINS[i], OUTPUT);
    digitalWrite(LED_PINS[i], LOW);
  }
  // Startup blink so we know it's alive
  for (int i = 0; i < NUM_LEDS; i++) {
    digitalWrite(LED_PINS[i], HIGH);
    delay(120);
    digitalWrite(LED_PINS[i], LOW);
  }
}

void loop() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    handleCommand(cmd);
  }
}

void handleCommand(const String& cmd) {
  if (!cmd.startsWith("SET ")) return;

  int firstSpace  = cmd.indexOf(' ');
  int secondSpace = cmd.indexOf(' ', firstSpace + 1);
  if (firstSpace == -1 || secondSpace == -1) return;

  int id    = cmd.substring(firstSpace + 1, secondSpace).toInt();
  int state = cmd.substring(secondSpace + 1).toInt();

  if (id < 0 || id >= NUM_LEDS) return;

  digitalWrite(LED_PINS[id], state ? HIGH : LOW);
  Serial.println("OK");
}
