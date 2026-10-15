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

class BluetoothOperationTimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'BluetoothOperationTimeoutError';
    this.code = 'BLE_OPERATION_TIMEOUT';
    this.operation = operation;
  }
}

export class SleepysBedController {
  constructor(log, options = {}) {
    this.log = log;
    this.createBluetooth = options.createBluetooth || createBluetooth;
    this.deviceNamePrefix = options.deviceNamePrefix || 'Star25';

    this.onPosition = options.onPosition || (() => {});
    this.onLightState = options.onLightState || (() => {});
    this.onColorState = options.onColorState || (() => {});

    this.operationTimeoutMs = options.operationTimeoutMs || 10000;
    this.connectTimeoutMs = options.connectTimeoutMs || 15000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs || 3000;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs || 30000;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 60 * 60 * 1000;
    this.lightRecoveryWindowMs = options.lightRecoveryWindowMs ?? 120000;
    this.motorRequestWindowMs = options.motorRequestWindowMs ?? 15000;
    this.reconnectDelaysMs = options.reconnectDelaysMs || [
      1000,
      2000,
      5000,
      10000,
      30000,
    ];

    this.bluetoothHandle = null;
    this.bluetooth = null;
    this.destroyBluetooth = null;
    this.adapter = null;
    this.device = null;
    this.gatt = null;
    this.tx = null;
    this.rx = null;

    this.connected = false;
    this.stopping = false;
    this.connectPromise = null;
    this.cleanupPromise = null;
    this.recoveryPromise = null;
    this.reconnectTimer = null;
    this.healthCheckTimer = null;
    this.reconnectFailures = 0;
    this.writeQueue = Promise.resolve();
    this.pendingLightCommands = new Map();
    this.lightRequestSequence = 0;
    this.lightFlushPromise = null;

    this.positions = {
      head: null,
      feet: null,
      lumbar: null,
    };

    this.motorBusy = false;
    this.motorCommandSent = false;
    this.motorZone = null;
    this.motorTarget = null;
    this.motorStartedAt = 0;
    this.motorTimeout = null;
    this.motorReleaseTimer = null;
    this.motorMinBusyMs = 1000;
    this.pendingMotorCommands = new Map();
    this.motorQueueDispatching = false;
  }

  async start() {
    this.stopping = false;

    try {
      await this.ensureConnected();
    } catch (error) {
      if (!this.stopping) {
        this.log.warn(
          `Initial Bluetooth connection failed (${error.message}); retrying in the background.`,
        );
        this.scheduleReconnect();
      }
    } finally {
      this.scheduleHealthCheck();
    }
  }

  async withTimeout(operation, timeoutMs, label) {
    let timer;

    const work = Promise.resolve().then(operation);
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new BluetoothOperationTimeoutError(label, timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async runBluetoothOperation(operation, label, timeoutMs = this.operationTimeoutMs) {
    const started = Date.now();
    try {
      return await this.withTimeout(operation, timeoutMs, label);
    } catch (error) {
      this.log.debug(`${label} failed after ${Date.now() - started}ms: ${error.message}`);
      throw error;
    }
  }

  async ensureBluetooth() {
    if (this.cleanupPromise) {
      await this.cleanupPromise;
    }

    if (this.bluetooth && this.adapter) return;

    // A previous defaultAdapter() call may have failed after opening D-Bus.
    // Never reuse that half-initialized session.
    this.destroyBluetoothSession();

    const bluetoothHandle = this.createBluetooth();

    try {
      const adapter = await this.runBluetoothOperation(
        () => bluetoothHandle.bluetooth.defaultAdapter(),
        'Bluetooth adapter initialization',
      );

      if (this.stopping) {
        throw new Error('Controller is stopping');
      }

      this.bluetoothHandle = bluetoothHandle;
      this.bluetooth = bluetoothHandle.bluetooth;
      this.destroyBluetooth = bluetoothHandle.destroy;
      this.adapter = adapter;
    } catch (error) {
      try {
        bluetoothHandle.destroy();
      } catch {
        // Preserve the adapter initialization error.
      }

      throw error;
    }
  }

  destroyBluetoothSession() {
    const destroyBluetooth = this.destroyBluetooth;
    const adapter = this.adapter;

    this.bluetoothHandle = null;
    this.bluetooth = null;
    this.destroyBluetooth = null;
    this.adapter = null;

    adapter?.helper?.removeListeners?.();

    if (destroyBluetooth) {
      try {
        destroyBluetooth();
      } catch (error) {
        this.log.debug(`Failed to close Bluetooth D-Bus session: ${error.message}`);
      }
    }
  }

  async ensureConnected() {
    if (this.stopping) {
      throw new Error('Controller is stopping');
    }

    if (this.cleanupPromise) {
      await this.cleanupPromise;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (this.connected && this.device && this.tx && this.rx) {
      try {
        if (await this.runBluetoothOperation(
          () => this.device.isConnected(),
          'Bluetooth connection check',
        )) {
          return;
        }

        this.log.debug('BlueZ reports the cached Bluetooth connection is stale.');
      } catch (error) {
        this.log.debug(
          `Unable to verify the cached Bluetooth connection: ${error.message}`,
        );
      }

      await this.cleanupConnection({ forgetDevice: true });
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    const connectionAttempt = (async () => {
      try {
        await this.connectOnce();
      } catch (error) {
        this.connected = false;
        await this.cleanupConnection({ forgetDevice: true });
        throw error;
      }
    })();

    this.connectPromise = connectionAttempt;

    try {
      await connectionAttempt;
    } finally {
      if (this.connectPromise === connectionAttempt) {
        this.connectPromise = null;
      }
    }
  }

  async findDevice() {
    await this.ensureBluetooth();

    const adapter = this.adapter;
    let startedDiscovery = false;

    if (!(await this.runBluetoothOperation(
      () => adapter.isDiscovering(),
      'Bluetooth discovery state check',
    ))) {
      await this.runBluetoothOperation(
        () => adapter.startDiscovery(),
        'Bluetooth discovery start',
      );
      startedDiscovery = true;
    }

    this.log.debug(
      `Scanning for Sleepy's Elite (${this.deviceNamePrefix}...)`,
    );

    const deadline = Date.now() + this.discoveryTimeoutMs;
    const scanStarted = Date.now();
    let deviceCount = 0;

    try {
      while (!this.stopping && Date.now() < deadline) {
        const ids = await this.runBluetoothOperation(
          () => adapter.devices(),
          'Bluetooth device listing',
        );
        deviceCount = ids.length;

        for (const id of ids) {
          const device = await this.runBluetoothOperation(
            () => adapter.getDevice(id),
            'Bluetooth device lookup',
          );

          let name = '';
          try {
            name = await this.runBluetoothOperation(
              () => device.getName(),
              'Bluetooth device name lookup',
            );
          } catch {
            // Ignore transient device-name read errors while scanning.
          }

          if (name.startsWith(this.deviceNamePrefix)) {
            this.log.debug(`Found bed ${name} after ${Date.now() - scanStarted}ms.`);
            return device;
          }

          this.removeDeviceListeners(device);
        }

        await sleep(1000);
      }
    } finally {
      if (startedDiscovery) {
        await this.runBluetoothOperation(
          () => adapter.stopDiscovery(),
          'Bluetooth discovery stop',
          this.cleanupTimeoutMs,
        ).catch(() => {});
      }
    }

    this.log.debug(`Bed discovery ended after ${Date.now() - scanStarted}ms; ${deviceCount} device records visible, no matching bed.`);
    throw new Error("Sleepy's Elite not found");
  }

  async connectOnce() {
    const device = await this.findDevice();
    this.device = device;

    let name = "Sleepy's Elite";
    try {
      name = await this.runBluetoothOperation(
        () => device.getName(),
        'Bluetooth device name lookup',
      );
    } catch {
      // Keep default name.
    }

    this.log.debug(`Connecting to ${name}...`);

    await this.runBluetoothOperation(
      () => device.connect(),
      'Bluetooth device connection',
      this.connectTimeoutMs,
    );

    const gatt = await this.runBluetoothOperation(
      () => device.gatt(),
      'Bluetooth GATT initialization',
    );
    this.gatt = gatt;

    const service = await this.runBluetoothOperation(
      () => gatt.getPrimaryService(SERVICE_UUID),
      'Bluetooth service lookup',
    );
    const tx = await this.runBluetoothOperation(
      () => service.getCharacteristic(TX_UUID),
      'Bluetooth transmit characteristic lookup',
    );
    this.tx = tx;

    const rx = await this.runBluetoothOperation(
      () => service.getCharacteristic(RX_UUID),
      'Bluetooth receive characteristic lookup',
    );
    this.rx = rx;

    // Proven working sequence for BOX25:
    // connect -> wake with response -> subscribe to notifications.
    await this.runBluetoothOperation(
      () => tx.writeValueWithResponse(WAKE),
      'Bluetooth wake command',
    );

    rx.removeAllListeners?.('valuechanged');
    rx.on('valuechanged', (value) => {
      this.handleNotification(Buffer.from(value));
    });

    await this.runBluetoothOperation(
      () => rx.startNotifications(),
      'Bluetooth notification setup',
    );

    this.connected = true;
    this.reconnectFailures = 0;

    this.log.info("Sleepy's Elite Bluetooth connected.");
    this.drainMotorQueue();
  }

  async cleanupConnection({ forgetDevice = false } = {}) {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    const cleanup = (async () => {
      this.connected = false;

      const rx = this.rx;
      const tx = this.tx;
      const device = this.device;
      const gatt = this.gatt;
      const adapter = this.adapter;

      this.tx = null;
      this.rx = null;
      this.device = null;
      this.gatt = null;

      if (rx) {
        try {
          await this.runBluetoothOperation(
            () => rx.stopNotifications(),
            'Bluetooth notification cleanup',
            this.cleanupTimeoutMs,
          );
        } catch {
          // A stale GATT object cannot accept StopNotify. Listener cleanup below
          // must still run so old D-Bus PropertiesChanged handlers do not pile up.
        } finally {
          rx.removeAllListeners?.('valuechanged');
          rx.helper?.removeListeners?.();
        }
      }

      if (tx && tx !== rx) {
        tx.removeAllListeners?.();
        tx.helper?.removeListeners?.();
      }

      // node-ble initializes helpers for every service/characteristic while it
      // resolves the GATT tree, not only the two characteristics we retain.
      // Dispose the whole tree so repeated reconnects cannot accumulate hidden
      // PropertiesChanged listeners.
      this.removeGattListeners(gatt);

      if (device) {
        let disconnectFailed = false;

        try {
          await this.runBluetoothOperation(
            () => device.disconnect(),
            'Bluetooth device disconnect',
            this.cleanupTimeoutMs,
          );
        } catch {
          disconnectFailed = true;
        } finally {
          this.removeDeviceListeners(device);
        }

        if (forgetDevice || disconnectFailed) {
          await this.forgetDevice(adapter, device);
        }
      }

      // Recreate the D-Bus session after every failed/stale connection. This is
      // the final safety net for node-ble proxy objects that are not public.
      this.destroyBluetoothSession();
    })();

    this.cleanupPromise = cleanup;

    try {
      await cleanup;
    } finally {
      if (this.cleanupPromise === cleanup) {
        this.cleanupPromise = null;
      }
    }
  }

  removeDeviceListeners(device) {
    device?.removeAllListeners?.();
    device?.helper?.removeListeners?.();
  }

  deviceObjectPath(device) {
    if (!device?.adapter || !device?.device) return null;
    return `/org/bluez/${device.adapter}/${device.device}`;
  }

  async forgetDevice(adapter, device) {
    const objectPath = this.deviceObjectPath(device);

    if (!objectPath || !adapter?.helper?.callMethod) return false;

    try {
      await this.runBluetoothOperation(
        () => adapter.helper.callMethod('RemoveDevice', objectPath),
        'Bluetooth stale device removal',
        this.cleanupTimeoutMs,
      );
      return true;
    } catch (error) {
      this.log.debug(`Failed to remove stale Bluetooth device: ${error.message}`);
      return false;
    }
  }

  removeGattListeners(gatt) {
    if (!gatt) return;

    for (const service of Object.values(gatt._services || {})) {
      for (const characteristic of Object.values(
        service?._characteristics || {},
      )) {
        characteristic?.removeAllListeners?.();
        characteristic?.helper?.removeListeners?.();
      }

      service?.helper?.removeListeners?.();
    }

    gatt.helper?.removeListeners?.();
  }

  isStaleConnectionError(error) {
    const message = `${error?.name || ''} ${error?.message || error || ''}`;
    const missingGattObject =
      /(WriteValue|GattCharacteristic).*(doesn't exist|does not exist|UnknownObject|not found|not connected)/i;

    return (
      missingGattObject.test(message) ||
      /org\.freedesktop\.DBus\.Error\.UnknownObject/i.test(message) ||
      /org\.bluez\.Error\.NotConnected/i.test(message) ||
      /(?:^|\s)(?:Sleepy's Elite|Device) not found$/i.test(message) ||
      /le-connection-abort-by-local/i.test(message) ||
      /ATT error:\s*0x0e/i.test(message) ||
      /BLE_OPERATION_TIMEOUT|BluetoothOperationTimeoutError/i.test(message)
    );
  }

  async recoverStaleConnection(failedTx, error) {
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }

    const recovery = (async () => {
      // Another failed command may have been waiting while the first one
      // replaced the stale characteristic. Do not tear down the fresh link.
      if (this.connected && this.tx && this.tx !== failedTx) {
        return;
      }

      this.log.debug(
        `Stale Bluetooth GATT connection detected (${error.message}); reconnecting now.`,
      );

      await this.cleanupConnection({ forgetDevice: true });
      await this.ensureConnected();
    })();

    this.recoveryPromise = recovery;

    try {
      await recovery;
    } finally {
      if (this.recoveryPromise === recovery) {
        this.recoveryPromise = null;
      }
    }
  }

  writeFrame(frame, beforeWrite = () => {}) {
    const queuedFrame = Buffer.from(frame);
    const operation = this.writeQueue.then(() =>
      this.writeFrameNow(queuedFrame, beforeWrite),
    );

    // Keep the queue usable after a failed command while returning the original
    // rejection to its caller.
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async writeFrameNow(frame, beforeWrite = () => {}) {
    let tx = this.tx;

    try {
      beforeWrite();
      await this.ensureConnected();
      beforeWrite();
      tx = this.tx;

      if (!tx) {
        throw new Error(
          'Bluetooth transmit characteristic is unavailable',
        );
      }

      await this.runBluetoothOperation(
        () => tx.writeValueWithoutResponse(frame),
        'Bluetooth command write',
      );
    } catch (error) {
      if (error.code === 'COMMAND_EXPIRED' || error.code === 'COMMAND_SUPERSEDED') {
        throw error;
      }
      if (this.stopping || !this.isStaleConnectionError(error)) {
        if (!this.stopping) {
          await this.cleanupConnection();
        }

        throw error;
      }

      try {
        beforeWrite();
      } catch (validationError) {
        // The original failure was a stale BLE link. Even when its command
        // has expired, restore connectivity without replaying the command.
        if (!this.stopping) {
          await this.cleanupConnection({ forgetDevice: true });
          this.scheduleReconnect();
        }
        throw validationError;
      }
      await this.recoverStaleConnection(tx, error);
      beforeWrite();

      // Retry the original frame exactly once whether the stale failure
      // happened during connection setup or during the first write.
      if (!this.tx) {
        const retryError = new Error(
          'Bluetooth transmit characteristic is unavailable',
        );

        if (!this.stopping) {
          await this.cleanupConnection();
        }

        throw retryError;
      }

      try {
        await this.runBluetoothOperation(
          () => this.tx.writeValueWithoutResponse(frame),
          'Bluetooth command retry',
        );
      } catch (retryError) {
        if (!this.stopping) {
          await this.cleanupConnection();
        }

        throw retryError;
      }
    }
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) {
      return;
    }

    const delayMs = this.reconnectDelayMs();
    this.log.debug(`Scheduling Bluetooth reconnect in ${delayMs}ms (failures: ${this.reconnectFailures}, pending light commands: ${this.pendingLightCommands.size}).`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      try {
        await this.ensureConnected();
        await this.flushPendingLightCommands();
      } catch (error) {
        this.reconnectFailures += 1;
        this.log.debug(`Reconnect failed: ${error.message}`);
        this.scheduleReconnect();
      }
    }, delayMs);
  }

  scheduleHealthCheck() {
    if (
      this.stopping ||
      this.healthCheckTimer ||
      this.healthCheckIntervalMs <= 0
    ) {
      return;
    }

    this.healthCheckTimer = setTimeout(async () => {
      this.healthCheckTimer = null;

      try {
        await this.checkConnectionHealth();
      } finally {
        this.scheduleHealthCheck();
      }
    }, this.healthCheckIntervalMs);

    this.healthCheckTimer.unref?.();
  }

  async checkConnectionHealth() {
    if (
      this.stopping ||
      this.connectPromise ||
      this.cleanupPromise ||
      this.recoveryPromise
    ) {
      return;
    }

    try {
      // This only asks BlueZ for the cached connection state. It does not send
      // a command to the bed when the existing connection is healthy.
      await this.ensureConnected();
      await this.flushPendingLightCommands();
    } catch (error) {
      if (!this.stopping) {
        this.log.debug(`Bluetooth health check failed: ${error.message}`);
        this.scheduleReconnect();
      }
    }
  }

  reconnectDelayMs() {
    const delayIndex = Math.min(
      this.reconnectFailures,
      this.reconnectDelaysMs.length - 1,
    );

    return this.reconnectDelaysMs[delayIndex];
  }

  assertCommandFresh(expiresAt, description) {
    if (this.stopping) throw new Error('Controller is stopping');
    if (Date.now() >= expiresAt) {
      const error = new Error(`${description} expired before transmission`);
      error.code = 'COMMAND_EXPIRED';
      this.log.debug(error.message);
      throw error;
    }
  }

  runLightCommand(kind, frame, description, options = {}) {
    // OFF also cancels older brightness/RGB commands, which can illuminate
    // the LEDs. A later ON/brightness/color request can supersede it normally.
    if (kind === 'power' && options.on === false) {
      this.pendingLightCommands.clear();
    }

    const request = {
      kind,
      frame: Buffer.from(frame),
      description,
      sequence: ++this.lightRequestSequence,
      expiresAt: Date.now() + this.lightRecoveryWindowMs,
      inFlight: false,
    };
    this.pendingLightCommands.set(kind, request);
    return this.sendPendingLightCommand(request);
  }

  async sendPendingLightCommand(request) {
    request.inFlight = true;
    try {
      await this.writeFrame(request.frame, () => {
        this.assertCommandFresh(request.expiresAt, `Light ${request.description}`);
        if (this.pendingLightCommands.get(request.kind) !== request) {
          const error = new Error('Light command superseded by a newer request');
          error.code = 'COMMAND_SUPERSEDED';
          throw error;
        }
      });
      if (this.pendingLightCommands.get(request.kind) === request) {
        this.pendingLightCommands.delete(request.kind);
      }
      this.log.info(`Sent ${request.description}`);
      return { sent: true };
    } catch (error) {
      const current = this.pendingLightCommands.get(request.kind) === request;
      if (current && !this.stopping && this.isStaleConnectionError(error) &&
        Date.now() < request.expiresAt) {
        this.log.debug(`Retaining light ${request.description} for recovery (${request.expiresAt - Date.now()}ms remaining): ${error.message}`);
        this.scheduleReconnect();
      } else if (current) {
        this.pendingLightCommands.delete(request.kind);
      }
      if (error.code === 'COMMAND_SUPERSEDED') {
        return { sent: false, reason: 'superseded' };
      }
      throw error;
    } finally {
      request.inFlight = false;
    }
  }

  async flushPendingLightCommands() {
    if (this.stopping || this.lightFlushPromise) return this.lightFlushPromise;
    const flush = (async () => {
      const requests = [...this.pendingLightCommands.values()]
        .sort((a, b) => a.sequence - b.sequence);
      for (const request of requests) {
        if (this.stopping) return;
        if (request.inFlight || this.pendingLightCommands.get(request.kind) !== request) continue;
        try {
          this.log.debug(`Replaying retained light ${request.description}.`);
          await this.sendPendingLightCommand(request);
        } catch (error) {
          this.log.debug(`Retained light ${request.description} recovery failed: ${error.message}`);
          if (!this.connected) break;
        }
      }
    })();
    this.lightFlushPromise = flush;
    try {
      await flush;
    } finally {
      if (this.lightFlushPromise === flush) this.lightFlushPromise = null;
    }
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

  buildColorCommand(red, green, blue) {
    const clamp = (value) =>
      Math.max(0, Math.min(255, Math.round(Number(value))));

    return Buffer.from([
      0x5A,
      0xE0,
      0x04,
      0x02,
      clamp(red),
      clamp(green),
      clamp(blue),
      0xA5,
    ]);
  }

  async setColor(red, green, blue) {
    const frame = this.buildColorCommand(red, green, blue);
    return this.runLightCommand('color', frame,
      `color RGB(${frame[4]}, ${frame[5]}, ${frame[6]})`);
  }

  buildBrightnessCommand(value) {
    const level = Math.max(
      1,
      Math.min(6, Math.round(Number(value) * 6 / 100)),
    );

    return Buffer.from([
      0x5A,
      0xE0,
      0x04,
      0x00,
      level,
      0x00,
      0x00,
      0xA5,
    ]);
  }

  async setLightPower(on) {
    const frame = Buffer.from(
      on ? '5A0103103073A5' : '5A0103103074A5', 'hex',
    );
    return this.runLightCommand('power', frame, `led ${on ? 'on' : 'off'}`, { on: Boolean(on) });
  }

  async turnLightOn(red, green, blue, brightness) {
    // Direct RGB illuminates the LEDs in the requested color. The dedicated
    // ON frame resets them to white, so omit it and restore brightness second.
    // Supersede an older OFF even if it is still queued or awaiting recovery.
    this.pendingLightCommands.delete('power');

    // Register both requests before awaiting BLE so each survives an outage.
    // writeQueue preserves color-before-brightness order on the wire.
    const results = await Promise.all([
      this.setColor(red, green, blue),
      this.set('led', brightness),
    ]);
    return { sent: results.every((result) => result?.sent !== false) };
  }

  motorTimeoutFor(zone, target) {
    const current = this.positions[zone];

    if (current === null) {
      return 12000;
    }

    const distance = Math.abs(target - current);
    return Math.max(4000, Math.min(15000, 4000 + distance * 120));
  }

  async set(zone, rawValue, options = {}) {
    const value = Math.max(0, Math.min(100, Math.round(Number(rawValue))));

    try {
      if (zone === 'led') {
        if (value === 0) {
          return this.setLightPower(false);
        }

        const frame = this.buildBrightnessCommand(value);

        return this.runLightCommand('brightness', frame, `led ${value}%`);
      }

      if (!(zone in ZONES)) {
        throw new Error(`Unknown bed zone: ${zone}`);
      }

      const expiresAt = options.expiresAt ?? Date.now() + this.motorRequestWindowMs;
      this.assertCommandFresh(expiresAt, `Motor ${zone} ${value}%`);

      if (this.motorBusy) {
        this.log.debug(
          `Queued ${zone} ${value}% while ${this.motorZone} is moving to ${this.motorTarget}%.`,
        );

        this.pendingMotorCommands.set(zone, { value, expiresAt });

        return {
          sent: false,
          queued: true,
          reason: 'motor-queued',
        };
      }

      this.motorBusy = true;
      this.motorCommandSent = false;
      this.motorZone = zone;
      this.motorTarget = value;
      this.motorStartedAt = Date.now();

      const timeoutMs = this.motorTimeoutFor(zone, value);

      if (this.motorTimeout) {
        clearTimeout(this.motorTimeout);
      }

      try {
        await this.writeFrame(this.buildMotorCommand(zone, value), () => {
          this.assertCommandFresh(expiresAt, `Motor ${zone} ${value}%`);
        });

        // A slow reconnection must not release the motor lock before the
        // motor command has actually been transmitted.
        this.motorStartedAt = Date.now();
        this.motorCommandSent = true;
        this.motorTimeout = setTimeout(() => {
          this.releaseMotor('timeout');
        }, timeoutMs);

        this.log.info(`Sent ${zone} ${value}%`);

        return { sent: true };
      } catch (error) {
        this.releaseMotor('write-error');
        throw error;
      }
    } catch (error) {
      if (!this.stopping &&
        (error.code !== 'COMMAND_EXPIRED' || !this.connected)) {
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
      if (this.motorReleaseTimer) {
        clearTimeout(this.motorReleaseTimer);
      }

      this.motorReleaseTimer = setTimeout(() => {
        this.motorReleaseTimer = null;
        this.releaseMotor('target-delay');
      }, this.motorMinBusyMs - elapsed);

      return;
    }

    if (this.motorTimeout) {
      clearTimeout(this.motorTimeout);
      this.motorTimeout = null;
    }

    if (this.motorReleaseTimer) {
      clearTimeout(this.motorReleaseTimer);
      this.motorReleaseTimer = null;
    }

    this.log.debug(
      `Motor ready (${reason}): ${this.motorZone} -> ${this.motorTarget}%`,
    );

    this.motorBusy = false;
    this.motorCommandSent = false;
    this.motorZone = null;
    this.motorTarget = null;
    this.motorStartedAt = 0;

    if (reason !== 'shutdown') {
      this.drainMotorQueue();
    }
  }

  drainMotorQueue() {
    if (
      this.stopping ||
      this.motorBusy ||
      this.motorQueueDispatching ||
      this.pendingMotorCommands.size === 0
    ) {
      return;
    }

    this.motorQueueDispatching = true;

    queueMicrotask(async () => {
      try {
        if (this.stopping || this.motorBusy) return;

        const next = this.pendingMotorCommands.entries().next().value;
        if (!next) return;

        const [zone, request] = next;
        this.pendingMotorCommands.delete(zone);

        try {
          await this.set(zone, request.value, { expiresAt: request.expiresAt });
        } catch (error) {
          if (!this.stopping) {
            this.log.warn(
              `Failed to send queued ${zone} ${request.value}%: ${error.message}`,
            );
          }
        }
      } finally {
        this.motorQueueDispatching = false;

        if (!this.motorBusy && this.pendingMotorCommands.size > 0) {
          this.drainMotorQueue();
        }
      }
    });
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
        this.motorCommandSent &&
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

      // BOX25 lighting state:
      // 0x31-0x37 = OEM presets, 0x38 = direct RGB mode.
      // RGB values are reported in bytes 16-18.
      if (
        data.length >= 19 &&
        data[14] >= 0x31 &&
        data[14] <= 0x38
      ) {
        this.onColorState({
          red: data[16],
          green: data[17],
          blue: data[18],
        });
      }
    }
  }

  async shutdown() {
    this.stopping = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.motorTimeout) {
      clearTimeout(this.motorTimeout);
      this.motorTimeout = null;
    }

    if (this.motorReleaseTimer) {
      clearTimeout(this.motorReleaseTimer);
      this.motorReleaseTimer = null;
    }

    this.pendingMotorCommands.clear();
    this.pendingLightCommands.clear();
    this.releaseMotor('shutdown');

    const pendingWork = [this.connectPromise, this.writeQueue]
      .filter(Boolean)
      .map((promise) => Promise.resolve(promise).catch(() => {}));

    if (pendingWork.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingWork),
        sleep(1500),
      ]);
    }

    await this.cleanupConnection();
  }
}
