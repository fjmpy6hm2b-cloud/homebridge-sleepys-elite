import assert from 'node:assert/strict';
import test from 'node:test';

import { SleepysElitePlatformAccessory } from '../platformAccessory.js';
import { SleepysBedController } from '../bedController.js';

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
    requestedLightPower: null,
    lightPowerRequestId: 0,
    lightDebounceMs: 700,
    lightUpdateTimer: null,
    pendingLightUpdate: null,
    lightUpdateInFlight: 0,
    lightOffPromise: null,
    shuttingDown: false,
    lastLightBrightness: 33,
    color: { hue: 0, saturation: 0 },
    services: {},
    debounceTimers: {},
    pendingValues: {},
    lastSent: {},
    lastSentAt: {},
    duplicateWindowMs: 2000,
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

test('turns on directly in the selected color and restores brightness', async () => {
  const { controller, lightService } = createLightAccessory();
  const calls = [];
  controller.color = { hue: 120, saturation: 100 };

  controller.bed = {
    async turnLightOn(red, green, blue, brightness) {
      calls.push([red, green, blue, brightness]);
      return { sent: true };
    },
  };

  await lightService.getCharacteristic(Characteristic.On).setter(true);
  await controller.flushLightUpdate();

  assert.equal(controller.lightOn, true);
  assert.equal(controller.values.led, 33);
  assert.equal(
    lightService.getCharacteristic(Characteristic.Brightness).value,
    33,
  );
  assert.deepEqual(calls, [[0, 255, 0, 33]]);
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

test('does not report the light on when color-first startup fails', async () => {
  const { controller, lightService } = createLightAccessory();
  controller.bed = {
    async turnLightOn() { throw new Error('Device not found'); },
  };
  await lightService.getCharacteristic(Characteristic.On).setter(true);
  await controller.flushLightUpdate();
  assert.equal(controller.lightOn, false);
  assert.equal(controller.values.led, 0);
});

test('an older ON completion cannot overwrite a newer OFF state', async () => {
  const { controller, lightService } = createLightAccessory();
  let finishOn;
  const pending = new Promise((resolve) => { finishOn = resolve; });
  controller.bed = {
    async setLightPower() { return { sent: true }; },
    async turnLightOn() { await pending; return { sent: true }; },
  };
  await lightService.getCharacteristic(Characteristic.On).setter(true);
  const oldOn = controller.flushLightUpdate();
  await lightService.getCharacteristic(Characteristic.On).setter(false);
  finishOn();
  await oldOn;
  assert.equal(controller.lightOn, false);
  assert.equal(controller.values.led, 0);
});

test('optional bed debug logging uses the normal log without enabling global debug', () => {
  const { controller } = createLightAccessory();
  const messages = [];
  controller.config = { debugBluetooth: true };
  controller.log.info = (...args) => messages.push(args);
  controller.bluetoothLogger().debug('scanning');
  assert.deepEqual(messages, [['[Bluetooth debug]', 'scanning']]);
});

test('OFF cancels a pending lighting update even if Bluetooth cannot send OFF', async () => {
  const { controller, lightService } = createLightAccessory();
  controller.lightOn = true;
  controller.queueLightUpdate({ hue: 120 });
  controller.bed = {
    async setLightPower() { throw new Error('Device not found'); },
  };
  await lightService.getCharacteristic(Characteristic.On).setter(false);
  assert.equal(controller.lightUpdateTimer, null);
  assert.equal(controller.pendingLightUpdate, null);
  assert.equal(controller.requestedLightPower, false);
});

test('color changes remain stored while a failed OFF request is pending', async () => {
  const { controller } = createLightAccessory();
  controller.lightOn = true;
  controller.requestedLightPower = false;
  let writes = 0;
  controller.bed = { async setColor() { writes += 1; } };
  controller.requestLightColor({ hue: 120 });
  await controller.flushLightUpdate();
  assert.equal(writes, 0);
});

function createConnectedLight() {
  const { controller, lightService } = createLightAccessory();
  const writes = [];
  const bed = new SleepysBedController({ debug() {}, info() {}, warn() {} });
  bed.connected = true;
  bed.ensureConnected = async () => {};
  bed.tx = { async writeValueWithoutResponse(frame) { writes.push(frame.toString('hex')); } };
  controller.bed = bed;
  controller.lastLightBrightness = 17;
  const set = (type, value) => lightService.getCharacteristic(Characteristic[type]).setter(value);
  return { controller, lightService, bed, writes, set };
}

for (const order of ['power-first', 'brightness-first']) {
  test(`groups ${order} startup with the selected color and only the new 83% brightness`, async () => {
    const { controller, writes, set } = createConnectedLight();
    await set('Hue', 0);
    await set('Saturation', 100);
    if (order === 'power-first') {
      await set('On', true);
      await set('Brightness', 83);
    } else {
      await set('Brightness', 83);
      await set('On', true);
    }
    assert.deepEqual(writes, []);
    await controller.flushLightUpdate();
    assert.deepEqual(writes, ['5ae00402ff0000a5', '5ae00400050000a5']);
    assert.equal(controller.values.led, 83);
    assert.equal(controller.lastLightBrightness, 83);
  });
}

test('collects hue and saturation arriving after ON without sending the old color', async () => {
  const { controller, writes, set } = createConnectedLight();
  await set('On', true);
  await set('Hue', 120);
  await set('Saturation', 100);
  await set('Brightness', 83);
  await controller.flushLightUpdate();
  assert.deepEqual(writes, ['5ae0040200ff00a5', '5ae00400050000a5']);
});

test('ON and an explicit remembered 17% send only one brightness frame', async () => {
  const { controller, writes, set } = createConnectedLight();
  await set('On', true);
  await set('Brightness', 17);
  await controller.flushLightUpdate();
  assert.deepEqual(writes, ['5ae00402ffffffa5', '5ae00400010000a5']);
});

test('waits for the shared 700 ms window before transmitting the latest target', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, writes, set } = createConnectedLight();
  await set('On', true);
  t.mock.timers.tick(400);
  await set('Brightness', 83);
  t.mock.timers.tick(699);
  assert.deepEqual(writes, []);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['5ae00402ffffffa5', '5ae00400050000a5']);
  assert.equal(controller.pendingLightUpdate, null);
});

for (const order of ['power-first', 'brightness-first']) {
  test(`sends OFF once for ${order} power-off and brightness-zero requests`, async () => {
    const { controller, writes, set } = createConnectedLight();
    controller.lightOn = true;
    controller.values.led = 83;
    const requests = order === 'power-first'
      ? [['On', false], ['Brightness', 0]]
      : [['Brightness', 0], ['On', false]];
    for (const [type, value] of requests) await set(type, value);
    assert.deepEqual(writes, ['5a0103103074a5']);
    assert.equal(controller.lastLightBrightness, 83);
  });
}

test('shares an in-flight OFF even when the second request arrives much later', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const { controller, set } = createConnectedLight();
  let finishOff;
  let calls = 0;
  const pending = new Promise((resolve) => { finishOff = resolve; });
  controller.bed = { async setLightPower() { calls += 1; await pending; return { sent: true }; } };
  const off = set('On', false);
  now = 6000;
  const zero = set('Brightness', 0);
  assert.equal(calls, 1);
  finishOff();
  await Promise.all([off, zero]);
  assert.equal(controller.lightOn, false);
});

test('OFF deduplication covers the next second but permits a later fresh OFF', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const { writes, set } = createConnectedLight();
  await set('On', false);
  now = 2000;
  await set('Brightness', 0);
  assert.deepEqual(writes, ['5a0103103074a5']);
  now = 4000;
  await set('On', false);
  assert.deepEqual(writes, ['5a0103103074a5', '5a0103103074a5']);
});

test('does not suppress OFF after an intervening ON', async () => {
  const { controller, writes, set } = createConnectedLight();
  await set('On', false);
  await set('On', true);
  await controller.flushLightUpdate();
  await set('On', false);
  await set('Brightness', 0);
  assert.deepEqual(writes, ['5a0103103074a5', '5ae00402ffffffa5', '5ae00400010000a5', '5a0103103074a5']);
});

test('OFF cancels a grouped startup before any RGB or brightness reaches the bed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, writes, set } = createConnectedLight();
  await set('On', true);
  await set('Hue', 120);
  await set('Saturation', 100);
  await set('Brightness', 83);
  await set('On', false);
  t.mock.timers.tick(1000);
  assert.deepEqual(writes, ['5a0103103074a5']);
  assert.equal(controller.pendingLightUpdate, null);
});

test('stores color edits while off and uses them when brightness alone turns the light on', async () => {
  const { controller, writes, set } = createConnectedLight();
  await set('On', false);
  await set('Hue', 120);
  await set('Saturation', 100);
  assert.deepEqual(writes, ['5a0103103074a5']);
  await set('Brightness', 83);
  await controller.flushLightUpdate();
  assert.deepEqual(writes, ['5a0103103074a5', '5ae0040200ff00a5', '5ae00400050000a5']);
});

test('keeps the newest target when an older ON completes during another update', async () => {
  const { controller, set } = createConnectedLight();
  let finishOn;
  const pending = new Promise((resolve) => { finishOn = resolve; });
  controller.bed = {
    async turnLightOn() { await pending; return { sent: true }; },
    async set() { return { sent: true }; },
  };
  await set('On', true);
  const oldOn = controller.flushLightUpdate();
  await set('Brightness', 83);
  finishOn();
  await oldOn;
  assert.equal(controller.values.led, 83);
  await controller.flushLightUpdate();
  assert.equal(controller.values.led, 83);
  assert.equal(controller.lastLightBrightness, 83);
});

test('feedback cannot replace the selected color or cancel an ON still being grouped', async () => {
  const { controller, writes, set } = createConnectedLight();
  await set('On', true);
  await set('Hue', 120);
  await set('Saturation', 100);
  controller.updateColorState({ red: 255, green: 255, blue: 255 });
  controller.updateLightState(false);
  assert.equal(controller.requestedLightPower, true);
  await controller.flushLightUpdate();
  assert.deepEqual(writes, ['5ae0040200ff00a5', '5ae00400010000a5']);
});

test('retains the combined explicit target through a Bluetooth outage', async () => {
  const { controller, bed, writes, set } = createConnectedLight();
  bed.ensureConnected = async () => { throw new Error('Device not found'); };
  bed.scheduleReconnect = () => {};
  await set('On', true);
  await set('Hue', 120);
  await set('Saturation', 100);
  await set('Brightness', 83);
  await controller.flushLightUpdate();
  await bed.writeQueue;
  assert.equal(bed.pendingLightCommands.size, 2);
  bed.ensureConnected = async () => {
    bed.tx = { async writeValueWithoutResponse(frame) { writes.push(frame.toString('hex')); } };
  };
  await bed.flushPendingLightCommands();
  assert.deepEqual(writes, ['5ae0040200ff00a5', '5ae00400050000a5']);
});

test('OFF after a failed grouped startup cancels retained RGB and brightness', async () => {
  const { controller, bed, writes, set } = createConnectedLight();
  bed.ensureConnected = async () => { throw new Error('Device not found'); };
  bed.scheduleReconnect = () => {};
  await set('On', true);
  await set('Brightness', 83);
  await controller.flushLightUpdate();
  await bed.writeQueue;
  await set('On', false);
  assert.deepEqual([...bed.pendingLightCommands.keys()], ['power']);
  bed.ensureConnected = async () => {
    bed.tx = { async writeValueWithoutResponse(frame) { writes.push(frame.toString('hex')); } };
  };
  await bed.flushPendingLightCommands();
  assert.deepEqual(writes, ['5a0103103074a5']);
});

test('shutdown cancels a lighting target still waiting to be grouped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, writes, set } = createConnectedLight();
  await set('On', true);
  await controller.shutdown();
  t.mock.timers.tick(1000);
  assert.deepEqual(writes, []);
  assert.equal(controller.pendingLightUpdate, null);
});
