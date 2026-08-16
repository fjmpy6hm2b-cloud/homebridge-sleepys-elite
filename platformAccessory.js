import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SleepysElitePlatformAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.config = platform.config;
    this.accessory = accessory;

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.python = this.config.pythonPath || 'python3';
    this.workerScript = path.join(__dirname, 'sleepy_worker.py');
    this.deviceNamePrefix =
      this.config.deviceNamePrefix ||
      this.accessory.context.deviceNamePrefix ||
      'Star25';

    this.values = {
      head: 0,
      feet: 0,
      lumbar: 0,
      led: 0,
    };

    this.lightOn = false;
    this.services = {};
    this.worker = null;
    this.stopping = false;
    this.restartTimer = null;

    this.motorDebounceMs = 700;
    this.lightDebounceMs = 700;
    this.debounceTimers = {};
    this.pendingValues = {};
    this.lastSent = {};
    this.lastSentAt = {};
    this.duplicateWindowMs = 2000;

    this.configureAccessoryInformation();
    this.createZone('Head', 'head');
    this.createZone('Feet', 'feet');
    this.createZone('Lumbar', 'lumbar');
    this.createZone('Light', 'led');

    this.startWorker();
  }

  configureAccessoryInformation() {
    const info = this.accessory.getService(this.Service.AccessoryInformation);

    info
      .setCharacteristic(this.Characteristic.Manufacturer, "Sleepy's")
      .setCharacteristic(this.Characteristic.Model, 'Elite / BOX25')
      .setCharacteristic(
        this.Characteristic.SerialNumber,
        this.deviceNamePrefix,
      );
  }

  createZone(name, zone) {
    let service = this.accessory.getServiceById(
      this.Service.Lightbulb,
      zone,
    );

    if (!service) {
      service = this.accessory.addService(
        this.Service.Lightbulb,
        name,
        zone,
      );
    }

    service.setCharacteristic(this.Characteristic.Name, name);

    if (this.Characteristic.ConfiguredName) {
      service.setCharacteristic(
        this.Characteristic.ConfiguredName,
        name,
      );
    }

    this.services[zone] = service;

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => {
        if (zone === 'led') {
          return this.lightOn;
        }

        return this.values[zone] > 0;
      })
      .onSet(async (value) => {
        const on = Boolean(value);

        if (zone === 'led') {
          if (!on) {
            this.cancelDebounce(zone);
            this.pendingValues[zone] = 0;
            this.values.led = 0;
            this.lightOn = false;
            this.sendSet('led', 0);
          } else {
            const target = this.values.led > 0 ? this.values.led : 100;
            this.values.led = target;
            this.lightOn = true;
            this.scheduleSet('led', target, this.lightDebounceMs);
          }

          return;
        }

        if (!on) {
          this.cancelDebounce(zone);
          this.pendingValues[zone] = 0;
          this.values[zone] = 0;
          this.sendSet(zone, 0);
        }
      });

    service
      .getCharacteristic(this.Characteristic.Brightness)
      .onGet(() => this.values[zone])
      .onSet(async (value) => {
        const position = Math.max(
          0,
          Math.min(100, Math.round(Number(value))),
        );

        this.values[zone] = position;

        if (zone === 'led') {
          this.lightOn = position > 0;
          this.scheduleSet(zone, position, this.lightDebounceMs);
        } else {
          this.scheduleSet(zone, position, this.motorDebounceMs);
        }
      });
  }

  cancelDebounce(zone) {
    if (this.debounceTimers[zone]) {
      clearTimeout(this.debounceTimers[zone]);
      delete this.debounceTimers[zone];
    }

    delete this.pendingValues[zone];
  }

  scheduleSet(zone, value, delayMs) {
    if (this.debounceTimers[zone]) {
      clearTimeout(this.debounceTimers[zone]);
    }

    this.pendingValues[zone] = value;

    this.debounceTimers[zone] = setTimeout(() => {
      delete this.debounceTimers[zone];

      const finalValue = this.pendingValues[zone];
      delete this.pendingValues[zone];

      this.sendSet(zone, finalValue);
    }, delayMs);
  }

  sendSet(zone, value) {
    const finalValue = Math.max(
      0,
      Math.min(100, Math.round(Number(value))),
    );

    const now = Date.now();

    if (
      this.lastSent[zone] === finalValue &&
      now - (this.lastSentAt[zone] || 0) < this.duplicateWindowMs
    ) {
      this.log.debug(`Skipped duplicate ${zone} ${finalValue}%`);
      return;
    }

    this.lastSent[zone] = finalValue;
    this.lastSentAt[zone] = now;

    this.sendToWorker({
      cmd: 'set',
      zone,
      value: finalValue,
    });
  }

  sendToWorker(message) {
    if (!this.worker || !this.worker.stdin || this.worker.stdin.destroyed) {
      this.log.warn('Bed worker is not available; retrying command shortly.');

      setTimeout(() => {
        if (!this.stopping) {
          this.sendToWorker(message);
        }
      }, 1000).unref();

      return;
    }

    try {
      this.worker.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.log.warn(`Could not send command to bed worker: ${error.message}`);
    }
  }

  startWorker() {
    if (this.stopping || this.worker) {
      return;
    }

    this.log.info("Starting persistent Sleepy's Elite Bluetooth worker...");

    const child = spawn(
      this.python,
      [this.workerScript, this.deviceNamePrefix],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    this.worker = child;

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      this.handleWorkerLine(line);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString().trim();

      if (text) {
        this.log.warn(`Bed worker stderr: ${text}`);
      }
    });

    child.on('error', (error) => {
      this.log.error(`Bed worker process error: ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      rl.close();

      if (this.worker === child) {
        this.worker = null;
      }

      if (this.stopping) {
        return;
      }

      this.log.warn(
        `Bed worker exited (code ${code}, signal ${signal || 'none'}); restarting in 2 seconds.`,
      );

      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.startWorker();
      }, 2000);
    });
  }

  handleWorkerLine(line) {
    let event;

    try {
      event = JSON.parse(line);
    } catch {
      this.log.debug(`Bed worker: ${line}`);
      return;
    }

    switch (event.event) {
      case 'starting':
        this.log.debug('Bed worker started.');
        break;

      case 'connecting':
        this.log.debug(`Connecting to ${event.name || "Sleepy's Elite"}...`);
        break;

      case 'connected':
        this.log.info("Sleepy's Elite Bluetooth connected.");
        break;

      case 'disconnected':
        this.log.info(
          "Sleepy's Elite Bluetooth disconnected; worker will reconnect.",
        );
        break;

      case 'reconnecting':
        this.log.debug("Sleepy's Elite Bluetooth reconnecting...");
        break;

      case 'position':
        this.updatePosition(event);
        break;

      case 'rx':
        this.handleRx(event.hex);
        break;

      case 'sent':
        this.log.info(
          `Sent ${event.zone || event.cmd}${
            event.value !== undefined ? ` ${event.value}%` : ''
          }`,
        );
        break;

      case 'motor_ignored':
        this.log.debug(
          `Ignored ${event.zone} ${event.value}% while ${event.active_zone} is moving to ${event.active_target}%.`,
        );
        break;

      case 'motor_busy':
      case 'motor_ready':
      case 'connect_error':
      case 'reconnect_error':
      case 'command_retry':
        this.log.debug(`${event.event}: ${JSON.stringify(event)}`);
        break;

      case 'command_error':
      case 'input_error':
        this.log.warn(`${event.event}: ${event.error || 'unknown error'}`);
        break;

      default:
        this.log.debug(`Bed worker event: ${line}`);
    }
  }

  updatePosition(event) {
    let changed = false;

    for (const zone of ['head', 'feet', 'lumbar']) {
      if (typeof event[zone] !== 'number') {
        continue;
      }

      const value = Math.max(
        0,
        Math.min(100, Math.round(event[zone])),
      );

      if (this.values[zone] !== value) {
        changed = true;
      }

      this.values[zone] = value;

      if (this.lastSent[zone] !== value) {
        delete this.lastSent[zone];
        delete this.lastSentAt[zone];
      }

      const service = this.services[zone];

      service
        .getCharacteristic(this.Characteristic.Brightness)
        .updateValue(value);

      service
        .getCharacteristic(this.Characteristic.On)
        .updateValue(value > 0);
    }

    if (changed) {
      this.log.info(
        `Bed position: Head ${this.values.head}%, Feet ${this.values.feet}%, Lumbar ${this.values.lumbar}%`,
      );
    }
  }

  handleRx(hex) {
    if (typeof hex !== 'string') {
      return;
    }

    const bytes = hex
      .trim()
      .split(/\s+/)
      .map((x) => parseInt(x, 16));

    if (bytes.length >= 15 && bytes[0] === 0xA5 && bytes[1] === 0x0B) {
      if (bytes[14] === 0x61) {
        this.lightOn = true;

        if (this.values.led === 0) {
          this.values.led = 100;
        }

        this.services.led
          .getCharacteristic(this.Characteristic.On)
          .updateValue(true);

        this.services.led
          .getCharacteristic(this.Characteristic.Brightness)
          .updateValue(this.values.led);
      } else if (bytes[14] === 0x60) {
        this.lightOn = false;
        this.values.led = 0;

        this.services.led
          .getCharacteristic(this.Characteristic.On)
          .updateValue(false);

        this.services.led
          .getCharacteristic(this.Characteristic.Brightness)
          .updateValue(0);
      }
    }
  }

  shutdown() {
    this.stopping = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    for (const timer of Object.values(this.debounceTimers)) {
      clearTimeout(timer);
    }

    if (!this.worker) {
      return;
    }

    try {
      this.worker.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
    } catch {
      // Ignore shutdown pipe errors.
    }

    setTimeout(() => {
      if (this.worker && !this.worker.killed) {
        try {
          this.worker.kill('SIGTERM');
        } catch {
          // Ignore shutdown process errors.
        }
      }
    }, 1000).unref();
  }
}
