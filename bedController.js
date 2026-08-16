import { createBluetooth } from 'node-ble';

const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const RX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const WAKE = Buffer.from('5A0B00A5', 'hex');

const ZONES = {
  head: 0x00,
  feet: 0x01,
  lumbar: 0x02,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SleepysBedController {
  constructor(log, options = {}) {
    this.log = log;
    this.deviceNamePrefix = options.deviceNamePrefix || 'Star25';

    this.onPosition = options.onPosition || (() => {});
    this.onLightState = options.onLightState || (() => {});

    this.bluetoothHandle = null;
    this.bluetooth = null;
    this.destroyBluetooth = null;
    this.adapter = null;
    this.device = null;
    this.tx = null;
    this.rx = null;

    this.connected = false;
    this.stopping = false;
    this.connectPromise = null;
    this.reconnectTimer = null;

    this.positions = {
      head: null,
      feet: null,
      lumbar: null,
    };

    this.motorBusy = false;
    this.motorZone = null;
    this.motorTarget = null;
    this.motorStartedAt = 0;
    this.motorTimeout = null;
    this.motorMinBusyMs = 1000;
  }

  async start() {
    this.stopping = false;
    await this.ensureConnected();
  }

  async ensureBluetooth() {
    if (this.bluetooth) return;

    this.bluetoothHandle = createBluetooth();
    this.bluetooth = this.bluetoothHandle.bluetooth;
    this.destroyBluetooth = this.bluetoothHandle.destroy;
    this.adapter = await this.bluetooth.defaultAdapter();
  }

  async ensureConnected() {
    if (this.stopping) {
      throw new Error('Controller is stopping');
    }

    if (this.connected && this.device && this.tx && this.rx) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectLoop();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async connectLoop() {
    while (!this.stopping) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        this.connected = false;
        this.log.debug(`Bluetooth connect failed: ${error.message}`);
        await this.cleanupConnection();
        await sleep(2000);
      }
    }
  }

  async findDevice() {
    await this.ensureBluetooth();

    if (!(await this.adapter.isDiscovering())) {
      await this.adapter.startDiscovery();
    }

    this.log.debug(
      `Scanning for Sleepy's Elite (${this.deviceNamePrefix}...)`,
    );

    const deadline = Date.now() + 30000;

    try {
      while (!this.stopping && Date.now() < deadline) {
        const ids = await this.adapter.devices();

        for (const id of ids) {
          const device = await this.adapter.getDevice(id);

          let name = '';
          try {
            name = await device.getName();
          } catch {
            // Ignore transient device-name read errors while scanning.
          }

          if (name.startsWith(this.deviceNamePrefix)) {
            return device;
          }
        }

        await sleep(1000);
      }
    } finally {
      await this.adapter.stopDiscovery().catch(() => {});
    }

    throw new Error("Sleepy's Elite not found");
  }

  async connectOnce() {
    const device = await this.findDevice();

    let name = "Sleepy's Elite";
    try {
      name = await device.getName();
    } catch {
      // Keep default name.
    }

    this.log.debug(`Connecting to ${name}...`);

    await device.connect();

    const gatt = await device.gatt();
    const service = await gatt.getPrimaryService(SERVICE_UUID);
    const tx = await service.getCharacteristic(TX_UUID);
    const rx = await service.getCharacteristic(RX_UUID);

    // Proven working sequence for BOX25:
    // connect -> wake with response -> subscribe to notifications.
    await tx.writeValueWithResponse(WAKE);

    rx.removeAllListeners?.('valuechanged');
    rx.on('valuechanged', (value) => {
      this.handleNotification(Buffer.from(value));
    });

    await rx.startNotifications();

    this.device = device;
    this.tx = tx;
    this.rx = rx;
    this.connected = true;

    this.log.info("Sleepy's Elite Bluetooth connected.");
  }

  async cleanupConnection() {
    this.connected = false;

    const rx = this.rx;
    const device = this.device;

    this.tx = null;
    this.rx = null;
    this.device = null;

    if (rx) {
      await rx.stopNotifications().catch(() => {});
    }

    if (device) {
      await device.disconnect().catch(() => {});
    }
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      try {
        await this.ensureConnected();
      } catch (error) {
        this.log.debug(`Reconnect failed: ${error.message}`);
        this.scheduleReconnect();
      }
    }, 1000);
  }

  buildMotorCommand(zone, value) {
    return Buffer.from([
      0x5A,
      0xF0,
      0x03,
      ZONES[zone],
      value,
      0x00,
      0xA5,
    ]);
  }

  buildLightCommands(value) {
    if (value === 0) {
      return [Buffer.from('5A0103103074A5', 'hex')];
    }

    const level = Math.max(1, Math.round(value * 6 / 100));

    return [
      Buffer.from('5A0103103073A5', 'hex'),
      Buffer.from([
        0x5A,
        0xE0,
        0x04,
        0x00,
        level,
        0x00,
        0x00,
        0xA5,
      ]),
    ];
  }

  motorTimeoutFor(zone, target) {
    const current = this.positions[zone];

    if (current === null) {
      return 12000;
    }

    const distance = Math.abs(target - current);
    return Math.max(4000, Math.min(15000, 4000 + distance * 120));
  }

  async set(zone, rawValue) {
    const value = Math.max(0, Math.min(100, Math.round(Number(rawValue))));

    try {
      await this.ensureConnected();

      if (zone === 'led') {
        for (const frame of this.buildLightCommands(value)) {
          await this.tx.writeValueWithoutResponse(frame);
          await sleep(100);
        }

        this.log.info(`Sent led ${value}%`);
        return { sent: true };
      }

      if (!(zone in ZONES)) {
        throw new Error(`Unknown bed zone: ${zone}`);
      }

      if (this.motorBusy) {
        this.log.debug(
          `Ignored ${zone} ${value}% while ${this.motorZone} is moving to ${this.motorTarget}%.`,
        );

        return {
          sent: false,
          reason: 'motor-busy',
        };
      }

      this.motorBusy = true;
      this.motorZone = zone;
      this.motorTarget = value;
      this.motorStartedAt = Date.now();

      const timeoutMs = this.motorTimeoutFor(zone, value);

      if (this.motorTimeout) {
        clearTimeout(this.motorTimeout);
      }

      this.motorTimeout = setTimeout(() => {
        this.releaseMotor('timeout');
      }, timeoutMs);

      try {
        await this.tx.writeValueWithoutResponse(
          this.buildMotorCommand(zone, value),
        );

        this.log.info(`Sent ${zone} ${value}%`);

        return { sent: true };
      } catch (error) {
        this.releaseMotor('write-error');
        throw error;
      }
    } catch (error) {
      if (!this.stopping) {
        await this.cleanupConnection();
        this.scheduleReconnect();
      }

      throw error;
    }
  }

  releaseMotor(reason) {
    if (!this.motorBusy) {
      return;
    }

    const elapsed = Date.now() - this.motorStartedAt;

    if (reason === 'target' && elapsed < this.motorMinBusyMs) {
      setTimeout(() => {
        this.releaseMotor('target-delay');
      }, this.motorMinBusyMs - elapsed);

      return;
    }

    if (this.motorTimeout) {
      clearTimeout(this.motorTimeout);
      this.motorTimeout = null;
    }

    this.log.debug(
      `Motor ready (${reason}): ${this.motorZone} -> ${this.motorTarget}%`,
    );

    this.motorBusy = false;
    this.motorZone = null;
    this.motorTarget = null;
    this.motorStartedAt = 0;
  }

  handleNotification(data) {
    if (data.length >= 9 && data[0] === 0xA5 && data[1] === 0x0D) {
      const position = {
        head: Math.max(0, Math.min(100, data[4])),
        feet: Math.max(0, Math.min(100, data[6])),
        lumbar: Math.max(0, Math.min(100, data[8])),
      };

      this.positions = position;
      this.onPosition(position);

      if (
        this.motorBusy &&
        this.motorZone &&
        Math.abs(position[this.motorZone] - this.motorTarget) <= 1
      ) {
        this.releaseMotor('target');
      }

      return;
    }

    if (data.length >= 15 && data[0] === 0xA5 && data[1] === 0x0B) {
      if (data[14] === 0x61) {
        this.onLightState(true);
      } else if (data[14] === 0x60) {
        this.onLightState(false);
      }
    }
  }

  async shutdown() {
    this.stopping = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.motorTimeout) {
      clearTimeout(this.motorTimeout);
      this.motorTimeout = null;
    }

    await this.cleanupConnection();

    if (this.destroyBluetooth) {
      this.destroyBluetooth();
    }

    this.bluetoothHandle = null;
    this.bluetooth = null;
    this.destroyBluetooth = null;
    this.adapter = null;
  }
}
