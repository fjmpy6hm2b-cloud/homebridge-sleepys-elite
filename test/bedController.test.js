import assert from 'node:assert/strict';
import test from 'node:test';

import { SleepysBedController } from '../bedController.js';

const log = {
  debug() {},
  info() {},
};

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
