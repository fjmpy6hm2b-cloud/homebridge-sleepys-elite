import assert from 'node:assert/strict';
import test from 'node:test';

import { SleepysBedController } from '../bedController.js';

const log = {
  debug() {},
  info() {},
  warn() {},
};

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const staleError = new Error(
  'Method "WriteValue" with signature "aya{sv}" on interface "org.bluez.GattCharacteristic1" doesn\'t exist',
);

test('recognizes stale BlueZ/GATT errors without retrying unrelated failures', () => {
  const controller = new SleepysBedController(log);

  assert.equal(controller.isStaleConnectionError(staleError), true);
  assert.equal(
    controller.isStaleConnectionError(
      new Error('org.freedesktop.DBus.Error.UnknownObject'),
    ),
    true,
  );
  assert.equal(
    controller.isStaleConnectionError(new Error('temporary write timeout')),
    false,
  );
});

test('reconnects immediately, retries once, and cleans stale listeners', async () => {
  const controller = new SleepysBedController(log);
  const frame = Buffer.from('5A0103103073A5', 'hex');
  const cleanupCalls = {
    rxEvent: 0,
    rxHelper: 0,
    txHelper: 0,
    deviceEvent: 0,
    deviceHelper: 0,
  };

  let oldWrites = 0;
  const oldTx = {
    async writeValueWithoutResponse() {
      oldWrites += 1;
      throw staleError;
    },
    helper: {
      removeListeners() {
        cleanupCalls.txHelper += 1;
      },
    },
  };

  const oldRx = {
    async stopNotifications() {
      throw new Error('StopNotify object no longer exists');
    },
    removeAllListeners(event) {
      assert.equal(event, 'valuechanged');
      cleanupCalls.rxEvent += 1;
    },
    helper: {
      removeListeners() {
        cleanupCalls.rxHelper += 1;
      },
    },
  };

  const oldDevice = {
    async isConnected() {
      return true;
    },
    async disconnect() {
      throw new Error('Disconnect object no longer exists');
    },
    removeAllListeners() {
      cleanupCalls.deviceEvent += 1;
    },
    helper: {
      removeListeners() {
        cleanupCalls.deviceHelper += 1;
      },
    },
  };

  let newWrites = 0;
  const newTx = {
    async writeValueWithoutResponse(retriedFrame) {
      assert.deepEqual(retriedFrame, frame);
      newWrites += 1;
    },
  };

  controller.connected = true;
  controller.device = oldDevice;
  controller.tx = oldTx;
  controller.rx = oldRx;

  let reconnects = 0;
  controller.connectOnce = async () => {
    reconnects += 1;
    controller.connected = true;
    controller.device = { async isConnected() { return true; } };
    controller.tx = newTx;
    controller.rx = {};
  };

  await controller.writeFrame(frame);

  assert.equal(oldWrites, 1);
  assert.equal(newWrites, 1);
  assert.equal(reconnects, 1);
  assert.deepEqual(cleanupCalls, {
    rxEvent: 1,
    rxHelper: 1,
    txHelper: 1,
    deviceEvent: 1,
    deviceHelper: 1,
  });
});

test('reconnects before writing when BlueZ reports a cached link is disconnected', async () => {
  const controller = new SleepysBedController(log);
  const frame = Buffer.from('5A0103103074A5', 'hex');

  let staleWrites = 0;
  controller.connected = true;
  controller.device = {
    async isConnected() {
      return false;
    },
    async disconnect() {},
    removeAllListeners() {},
    helper: { removeListeners() {} },
  };
  controller.tx = {
    async writeValueWithoutResponse() {
      staleWrites += 1;
    },
    helper: { removeListeners() {} },
  };
  controller.rx = {
    async stopNotifications() {},
    removeAllListeners() {},
    helper: { removeListeners() {} },
  };

  let reconnects = 0;
  let freshWrites = 0;
  controller.connectOnce = async () => {
    reconnects += 1;
    controller.connected = true;
    controller.device = { async isConnected() { return true; } };
    controller.tx = {
      async writeValueWithoutResponse(writtenFrame) {
        assert.deepEqual(writtenFrame, frame);
        freshWrites += 1;
      },
    };
    controller.rx = {};
  };

  await controller.writeFrame(frame);

  assert.equal(staleWrites, 0);
  assert.equal(freshWrites, 1);
  assert.equal(reconnects, 1);
});

test('recreates a half-initialized node-ble session after adapter failure', async () => {
  let attempts = 0;
  let destroyed = 0;
  const adapter = {};

  const controller = new SleepysBedController(log, {
    createBluetooth() {
      return {
        bluetooth: {
          async defaultAdapter() {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('No available adapters found');
            }

            return adapter;
          },
        },
        destroy() {
          destroyed += 1;
        },
      };
    },
  });

  await assert.rejects(
    controller.ensureBluetooth(),
    /No available adapters found/,
  );

  assert.equal(controller.bluetooth, null);
  assert.equal(controller.adapter, null);

  await controller.ensureBluetooth();

  assert.equal(attempts, 2);
  assert.equal(destroyed, 1);
  assert.equal(controller.adapter, adapter);

  await controller.cleanupConnection();
  assert.equal(destroyed, 2);
});

test('returns a failed connection attempt instead of waiting forever', async () => {
  const controller = new SleepysBedController(log);
  let attempts = 0;

  controller.connectOnce = async () => {
    attempts += 1;
    throw new Error('bed unavailable');
  };

  await assert.rejects(controller.ensureConnected(), /bed unavailable/);

  assert.equal(attempts, 1);
  assert.equal(controller.connectPromise, null);
  assert.equal(controller.connected, false);
});

test('cleans the complete GATT tree and destroys the D-Bus session', async () => {
  const calls = {
    characteristic: 0,
    service: 0,
    gatt: 0,
    destroy: 0,
  };

  const controller = new SleepysBedController(log);
  controller.bluetooth = {};
  controller.adapter = {};
  controller.destroyBluetooth = () => {
    calls.destroy += 1;
  };
  controller.gatt = {
    helper: {
      removeListeners() {
        calls.gatt += 1;
      },
    },
    _services: {
      service1: {
        helper: {
          removeListeners() {
            calls.service += 1;
          },
        },
        _characteristics: {
          unused: {
            removeAllListeners() {},
            helper: {
              removeListeners() {
                calls.characteristic += 1;
              },
            },
          },
        },
      },
    },
  };

  await controller.cleanupConnection();

  assert.deepEqual(calls, {
    characteristic: 1,
    service: 1,
    gatt: 1,
    destroy: 1,
  });
  assert.equal(controller.gatt, null);
  assert.equal(controller.bluetooth, null);
  assert.equal(controller.adapter, null);
});

test('serializes concurrent BLE writes in their original order', async () => {
  const controller = new SleepysBedController(log);
  const started = [];
  let releaseFirst;

  controller.connected = true;
  controller.device = {
    async isConnected() {
      return true;
    },
  };
  controller.rx = {};
  controller.tx = {
    async writeValueWithoutResponse(frame) {
      started.push(frame[0]);

      if (frame[0] === 1) {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
    },
  };

  const first = controller.writeFrame(Buffer.from([1]));
  const second = controller.writeFrame(Buffer.from([2]));

  await nextTurn();
  assert.deepEqual(started, [1]);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(started, [1, 2]);
});

test('queues a second motor zone and sends it after the first finishes', async () => {
  const controller = new SleepysBedController(log);
  const writes = [];

  controller.writeFrame = async (frame) => {
    writes.push(Buffer.from(frame));
  };

  const first = await controller.set('head', 25);
  const second = await controller.set('feet', 40);

  assert.equal(first.sent, true);
  assert.deepEqual(second, {
    sent: false,
    queued: true,
    reason: 'motor-queued',
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][3], 0x00);

  controller.motorStartedAt = Date.now() - controller.motorMinBusyMs;
  controller.releaseMotor('target');
  await nextTurn();

  assert.equal(writes.length, 2);
  assert.equal(writes[1][3], 0x01);
  assert.equal(writes[1][4], 40);
  assert.equal(controller.motorZone, 'feet');

  controller.releaseMotor('shutdown');
});
