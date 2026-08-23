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
    const storedLightBrightness = Number(
      this.accessory.context.lastLightBrightness,
    );
    this.lastLightBrightness = Number.isFinite(storedLightBrightness) &&
      storedLightBrightness > 0
      ? Math.max(1, Math.min(100, Math.round(storedLightBrightness)))
      : 100;
    this.color = {
      hue: 0,
      saturation: 0,
    };
    this.services = {};
    this.motorDebounceMs = 700;
    this.lightDebounceMs = 700;
    this.colorDebounceMs = 250;
    this.colorDebounceTimer = null;
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

      this.bed = new SleepysBedController(
        this.log,
        this.controllerOptions(),
      );

      await this.bed.start();
    } catch (error) {
      this.log.warn(`Bluetooth is unavailable: ${error.message}`);
    }
  }

  controllerOptions() {
    return {
      deviceNamePrefix: this.deviceNamePrefix,
      onPosition: (position) => this.updatePosition(position),
      onLightState: (on) => this.updateLightState(on),
      onColorState: (rgb) => this.updateColorState(rgb),
    };
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

    if (zone === 'led') {
      service
        .getCharacteristic(this.Characteristic.Hue)
        .onGet(() => this.color.hue)
        .onSet(async (value) => {
          this.color.hue = Math.max(
            0,
            Math.min(360, Number(value)),
          );
          this.scheduleColorSet();
        });

      service
        .getCharacteristic(this.Characteristic.Saturation)
        .onGet(() => this.color.saturation)
        .onSet(async (value) => {
          this.color.saturation = Math.max(
            0,
            Math.min(100, Number(value)),
          );
          this.scheduleColorSet();
        });
    }

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => {
        if (zone === 'led') return this.lightOn;
        return this.values[zone] > 0;
      })
      .onSet(async (value) => {
        const on = Boolean(value);

        if (zone === 'led') {
          this.cancelDebounce(zone);

          if (!this.bed) {
            this.log.debug(
              `Ignored light ${on ? 'on' : 'off'} because Bluetooth is unavailable.`,
            );
            return;
          }

          try {
            if (!on) {
              this.rememberLightBrightness(this.values.led);
              await this.bed.setLightPower(false);
              this.lightOn = false;
              this.values.led = 0;

              this.services.led
                .getCharacteristic(this.Characteristic.Brightness)
                .updateValue(0);
            } else {
              await this.bed.setLightPower(true);
              this.lightOn = true;
              this.values.led = this.lastLightBrightness;

              this.services.led
                .getCharacteristic(this.Characteristic.Brightness)
                .updateValue(this.values.led);

              // Restore the last hardware brightness after BOX25's dedicated
              // ON command, which otherwise returns to its own default level.
              await this.bed.set('led', this.values.led);

              // BOX25's dedicated ON command resets the LEDs to white,
              // so restore the HomeKit-selected RGB color immediately.
              const { red, green, blue } = this.hsvToRgb(
                this.color.hue,
                this.color.saturation,
              );

              await this.bed.setColor(red, green, blue);
            }
          } catch (error) {
            this.log.warn(
              `Failed to turn light ${on ? 'on' : 'off'}: ${error.message}`,
            );
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
        const requested = Math.max(
          0,
          Math.min(100, Math.round(Number(value))),
        );

        const position = zone === 'led'
          ? this.snapLightBrightness(requested)
          : requested;

        if (zone === 'led') {
          if (position > 0) {
            this.rememberLightBrightness(position);
          } else {
            this.rememberLightBrightness(this.values.led);
          }

          this.values.led = position;
          this.lightOn = position > 0;

          // Report the actual BOX25 brightness step back to HomeKit so
          // the slider settles on 17/33/50/67/83/100 instead of showing
          // precision the hardware does not support.
          if (position !== requested) {
            this.services.led
              .getCharacteristic(this.Characteristic.Brightness)
              .updateValue(position);
          }

          this.scheduleSet(zone, position, this.lightDebounceMs);
        } else {
          this.values[zone] = position;
          this.scheduleSet(zone, position, this.motorDebounceMs);
        }
      });
  }

  rememberLightBrightness(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;

    const brightness = Math.max(
      0,
      Math.min(100, Math.round(numericValue)),
    );

    if (brightness <= 0) return;

    this.lastLightBrightness = brightness;
    this.accessory.context.lastLightBrightness = brightness;
  }

  snapLightBrightness(value) {
    const requested = Math.max(
      0,
      Math.min(100, Math.round(Number(value))),
    );

    if (requested === 0) {
      return 0;
    }

    const level = Math.max(
      1,
      Math.min(6, Math.round(requested * 6 / 100)),
    );

    return Math.round(level * 100 / 6);
  }

  scheduleColorSet() {
    if (this.colorDebounceTimer) {
      clearTimeout(this.colorDebounceTimer);
    }

    this.colorDebounceTimer = setTimeout(async () => {
      this.colorDebounceTimer = null;

      if (!this.bed) {
        this.log.debug(
          'Ignored color change because Bluetooth is unavailable.',
        );
        return;
      }

      // Remember HomeKit color changes while the light is off, but do not
      // transmit them because a direct RGB command also illuminates the LEDs.
      if (!this.lightOn) {
        this.log.debug('Stored light color while light is off.');
        return;
      }

      const { red, green, blue } = this.hsvToRgb(
        this.color.hue,
        this.color.saturation,
      );

      try {
        await this.bed.setColor(red, green, blue);
      } catch (error) {
        this.log.warn(`Failed to set light color: ${error.message}`);
      }
    }, this.colorDebounceMs);
  }

  hsvToRgb(hue, saturation) {
    const h = ((Number(hue) % 360) + 360) % 360;
    const s = Math.max(0, Math.min(100, Number(saturation))) / 100;

    const c = s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = 1 - c;

    let r = 0;
    let g = 0;
    let b = 0;

    if (h < 60) {
      r = c; g = x;
    } else if (h < 120) {
      r = x; g = c;
    } else if (h < 180) {
      g = c; b = x;
    } else if (h < 240) {
      g = x; b = c;
    } else if (h < 300) {
      r = x; b = c;
    } else {
      r = c; b = x;
    }

    return {
      red: Math.round((r + m) * 255),
      green: Math.round((g + m) * 255),
      blue: Math.round((b + m) * 255),
    };
  }

  rgbToHsv(red, green, blue) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;

    if (delta !== 0) {
      if (max === r) {
        hue = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        hue = 60 * (((b - r) / delta) + 2);
      } else {
        hue = 60 * (((r - g) / delta) + 4);
      }
    }

    if (hue < 0) {
      hue += 360;
    }

    const saturation = max === 0 ? 0 : (delta / max) * 100;

    return {
      hue: Math.round(hue),
      saturation: Math.round(saturation),
    };
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
      } else if (result?.queued) {
        this.log.debug(`Queued ${zone} ${finalValue}% for the bed controller.`);
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

  updateColorState(rgb) {
    if (
      typeof rgb?.red !== 'number' ||
      typeof rgb?.green !== 'number' ||
      typeof rgb?.blue !== 'number'
    ) {
      return;
    }

    const color = this.rgbToHsv(
      rgb.red,
      rgb.green,
      rgb.blue,
    );

    this.color = color;

    this.services.led
      .getCharacteristic(this.Characteristic.Hue)
      .updateValue(color.hue);

    this.services.led
      .getCharacteristic(this.Characteristic.Saturation)
      .updateValue(color.saturation);

    this.log.debug(
      `Light color: RGB(${rgb.red}, ${rgb.green}, ${rgb.blue}) ` +
      `Hue ${color.hue}°, Saturation ${color.saturation}%`,
    );
  }

  updateLightState(on) {
    this.lightOn = Boolean(on);

    if (!this.lightOn) {
      this.rememberLightBrightness(this.values.led);
      this.values.led = 0;
    } else if (this.values.led === 0) {
      this.values.led = this.lastLightBrightness;
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

    if (this.colorDebounceTimer) {
      clearTimeout(this.colorDebounceTimer);
      this.colorDebounceTimer = null;
    }

    if (this.bed) {
      await this.bed.shutdown();
      this.bed = null;
    }
  }
}
