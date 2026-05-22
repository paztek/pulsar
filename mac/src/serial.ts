import { SerialPort } from 'serialport';
import { config } from './config';
import { LedId } from './types';

export class ArduinoController {
  private port: SerialPort;
  private ledStates: boolean[] = [false, false, false, false];

  constructor() {
    this.port = new SerialPort({
      path: config.serial.port,
      baudRate: config.serial.baudRate,
      autoOpen: false,
    });
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) { reject(err); return; }
        // Arduino resets on serial connect — wait for it to boot
        setTimeout(resolve, 2000);
      });
    });
  }

  setLed(id: LedId, on: boolean): Promise<void> {
    if (this.ledStates[id] === on) return Promise.resolve();
    this.ledStates[id] = on;
    return new Promise((resolve, reject) => {
      this.port.write(`SET ${id} ${on ? 1 : 0}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  allOff(): Promise<void[]> {
    return Promise.all(
      ([0, 1, 2, 3] as LedId[]).map((id) => this.setLed(id, false))
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.port.close(() => resolve()));
  }
}
