import assert from 'node:assert/strict';
import test from 'node:test';

import { SleepysElitePlatformAccessory } from '../platformAccessory.js';

const Characteristic = {
  Name: 'Name',
  ConfiguredName: 'ConfiguredName',
  Hue: 'Hue',
  Saturation: 'Saturation',
  On: 'On',
  Brightness: 'Brightness',
};

class FakeCharacteristic {
  onGet(handler) {
    this.getter = handler;
    return this;
  }

  onSet(handler) {
    this.setter = handler;
    return this;
  }

  updateValue(value) {
    this.value = value;
    return this;
  }
}

class FakeService {
  constructor() {
    this.characteristics = new Map();
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type)) {
      this.characteristics.set(type, new FakeCharacteristic());
    }

    return this.characteristics.get(type);
  }

  setCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }
}

function createLightAccessory() {
  const lightService = new FakeService();
  const controller = Object.create(SleepysElitePlatformAccessory.prototype);

  Object.assign(controller, {
    Service: { Lightbulb: 'Lightbulb' },
    Characteristic,
    accessory: {
      context: {},
      getServiceById() {
        return lightService;
      },
    },
    log: {
      debug() {},
      warn() {},
    },
    values: { head: 0, feet: 0, lumbar: 0, led: 0 },
    lightOn: false,
    lastLightBrightness: 33,
    color: { hue: 0, saturation: 0 },
    services: {},
    debounceTimers: {},
    pendingValues: {},
  });

  controller.createZone('Light', 'led');
  return { controller, lightService };
}

test('wires physical position, power, and color callbacks', () => {
  const controller = Object.create(SleepysElitePlatformAccessory.prototype);
  const received = {};

  controller.deviceNamePrefix = 'Star25';
  controller.updatePosition = (value) => { received.position = value; };
  controller.updateLightState = (value) => { received.light = value; };
  controller.updateColorState = (value) => { received.color = value; };

  const options = controller.controllerOptions();
  options.onPosition({ head: 10 });
  options.onLightState(true);
  options.onColorState({ red: 1, green: 2, blue: 3 });

  assert.equal(options.deviceNamePrefix, 'Star25');
  assert.deepEqual(received, {
    position: { head: 10 },
    light: true,
    color: { red: 1, green: 2, blue: 3 },
  });
});

test('restores brightness and color when the under-bed light is turned on', async () => {
  const { controller, lightService } = createLightAccessory();
  const calls = [];

  controller.bed = {
    async setLightPower(on) {
      calls.push(['power', on]);
    },
    async set(zone, value) {
      calls.push(['set', zone, value]);
      return { sent: true };
    },
    async setColor(red, green, blue) {
      calls.push(['color', red, green, blue]);
    },
  };

  await lightService.getCharacteristic(Characteristic.On).setter(true);

  assert.equal(controller.lightOn, true);
  assert.equal(controller.values.led, 33);
  assert.equal(
    lightService.getCharacteristic(Characteristic.Brightness).value,
    33,
  );
  assert.deepEqual(calls, [
    ['power', true],
    ['set', 'led', 33],
    ['color', 255, 255, 255],
  ]);
});

test('physical light power updates preserve the last nonzero brightness', () => {
  const { controller, lightService } = createLightAccessory();

  controller.values.led = 67;
  controller.updateLightState(false);

  assert.equal(controller.values.led, 0);
  assert.equal(controller.lastLightBrightness, 67);

  controller.updateLightState(true);

  assert.equal(controller.values.led, 67);
  assert.equal(
    lightService.getCharacteristic(Characteristic.Brightness).value,
    67,
  );
});
