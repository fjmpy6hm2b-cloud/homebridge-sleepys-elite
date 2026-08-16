import { existsSync } from 'node:fs';

export class SleepysElitePlatformAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.config = platform.config;
    this.accessory = accessory;

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

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

    this.bed = null;
    this.initializeBluetooth();
  }

  async initializeBluetooth() {
    // Verification/test environments may not expose the host BlueZ system bus.
    // The plugin must still load cleanly when Bluetooth is unavailable.
    if (!existsSync('/run/dbus/system_bus_socket')) {
      this.log.debug(
        'BlueZ system D-Bus is unavailable; Bluetooth connection will not be started.',
      );
      return;
    }

    try {
      const { SleepysBedController } = await import('./bedController.js');

      this.bed = new SleepysBedController(this.log, {
        deviceNamePrefix: this.deviceNamePrefix,
        onPosition: (position) => this.updatePosition(position),
        onLightState: (on) => this.updateLightState(on),
      });

      await this.bed.start();
    } catch (error) {
      this.log.warn(`Bluetooth is unavailable: ${error.message}`);
    }
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
        if (zone === 'led') return this.lightOn;
        return this.values[zone] > 0;
      })
      .onSet(async (value) => {
        const on = Boolean(value);

        if (zone === 'led') {
          if (!on) {
            this.cancelDebounce(zone);
            this.values.led = 0;
            this.lightOn = false;
            await this.sendSet('led', 0);
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
          this.values[zone] = 0;
          await this.sendSet(zone, 0);
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

    this.debounceTimers[zone] = setTimeout(async () => {
      delete this.debounceTimers[zone];

      const finalValue = this.pendingValues[zone];
      delete this.pendingValues[zone];

      await this.sendSet(zone, finalValue);
    }, delayMs);
  }

  async sendSet(zone, value) {
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

    if (!this.bed) {
      this.log.debug(
        `Ignored ${zone} ${finalValue}% because Bluetooth is unavailable.`,
      );
      return;
    }

    try {
      const result = await this.bed.set(zone, finalValue);

      if (result?.sent !== false) {
        this.lastSent[zone] = finalValue;
        this.lastSentAt[zone] = now;
      }
    } catch (error) {
      this.log.warn(`Failed to set ${zone} to ${finalValue}%: ${error.message}`);
    }
  }

  updatePosition(position) {
    let changed = false;

    for (const zone of ['head', 'feet', 'lumbar']) {
      if (typeof position[zone] !== 'number') continue;

      const value = Math.max(
        0,
        Math.min(100, Math.round(position[zone])),
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

  updateLightState(on) {
    this.lightOn = Boolean(on);

    if (!this.lightOn) {
      this.values.led = 0;
    } else if (this.values.led === 0) {
      this.values.led = 100;
    }

    this.services.led
      .getCharacteristic(this.Characteristic.On)
      .updateValue(this.lightOn);

    this.services.led
      .getCharacteristic(this.Characteristic.Brightness)
      .updateValue(this.values.led);
  }

  async shutdown() {
    for (const timer of Object.values(this.debounceTimers)) {
      clearTimeout(timer);
    }

    if (this.bed) {
      await this.bed.shutdown();
    }
  }
}
