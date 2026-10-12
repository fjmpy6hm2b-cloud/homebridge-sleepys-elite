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
  assert.equal(
    controller.isStaleConnectionError(
      new Error('le-connection-abort-by-local'),
    ),
    true,
  );
  assert.equal(
    controller.isStaleConnectionError(
      new Error('Operation failed with ATT error: 0x0e'),
    ),
    true,
  );
  assert.equal(
    controller.isStaleConnectionError(
      Object.assign(new Error('Bluetooth discovery start timed out'), {
        name: 'BluetoothOperationTimeoutError',
        code: 'BLE_OPERATION_TIMEOUT',
      }),
    ),
    true,
  );
});

test('times out a stuck BlueZ discovery call and recreates its session', async () => {
  let destroyed = 0;
  let adapterListenersRemoved = 0;

  const adapter = {
    async isDiscovering() {
      return false;
    },
    async startDiscovery() {
      return new Promise(() => {});
    },
    helper: {
      removeListeners() {
        adapterListenersRemoved += 1;
      },
    },
  };

  const controller = new SleepysBedController(log, {
    operationTimeoutMs: 10,
    cleanupTimeoutMs: 10,
    createBluetooth() {
      return {
        bluetooth: {
          async defaultAdapter() {
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
    controller.ensureConnected(),
    /Bluetooth discovery start timed out after 10ms/,
  );

  assert.equal(controller.connectPromise, null);
  assert.equal(controller.bluetooth, null);
  assert.equal(controller.adapter, null);
  assert.equal(adapterListenersRemoved, 1);
  assert.equal(destroyed, 1);
});

test('bounds a stuck disconnect and removes the stale BlueZ device', async () => {
  const removeCalls = [];
  let destroyed = 0;

  const controller = new SleepysBedController(log, {
    cleanupTimeoutMs: 10,
  });

  controller.bluetooth = {};
  controller.adapter = {
    helper: {
      async callMethod(method, objectPath) {
        removeCalls.push([method, objectPath]);
      },
      removeListeners() {},
    },
  };
  controller.destroyBluetooth = () => {
    destroyed += 1;
  };
  controller.device = {
    adapter: 'hci0',
    device: 'dev_CF_E5_D0_96_AF_C5',
    async disconnect() {
      return new Promise(() => {});
    },
    removeAllListeners() {},
    helper: { removeListeners() {} },
  };

  await controller.cleanupConnection({ forgetDevice: true });

  assert.deepEqual(removeCalls, [[
    'RemoveDevice',
    '/org/bluez/hci0/dev_CF_E5_D0_96_AF_C5',
  ]]);
  assert.equal(destroyed, 1);
  assert.equal(controller.device, null);
  assert.equal(controller.bluetooth, null);
});

test('uses bounded reconnect backoff and caps the delay', () => {
  const controller = new SleepysBedController(log, {
    reconnectDelaysMs: [1000, 2000, 5000],
  });

  assert.equal(controller.reconnectDelayMs(), 1000);
  controller.reconnectFailures = 1;
  assert.equal(controller.reconnectDelayMs(), 2000);
  controller.reconnectFailures = 20;
  assert.equal(controller.reconnectDelayMs(), 5000);
});

test('hourly health check leaves a healthy Bluetooth link alone', async () => {
  const controller = new SleepysBedController(log);
  let connectionChecks = 0;
  let reconnects = 0;

  controller.connected = true;
  controller.device = {
    async isConnected() {
      connectionChecks += 1;
      return true;
    },
  };
  controller.tx = {};
  controller.rx = {};
  controller.connectOnce = async () => {
    reconnects += 1;
  };

  await controller.checkConnectionHealth();

  assert.equal(connectionChecks, 1);
  assert.equal(reconnects, 0);
  assert.equal(controller.connected, true);
});

test('hourly health check reconnects a disconnected Bluetooth link', async () => {
  const controller = new SleepysBedController(log);
  let connectionChecks = 0;
  let reconnects = 0;

  controller.connected = true;
  controller.device = {
    adapter: 'hci0',
    device: 'dev_CF_E5_D0_96_AF_C5',
    async isConnected() {
      connectionChecks += 1;
      return false;
    },
    async disconnect() {},
    removeAllListeners() {},
    helper: { removeListeners() {} },
  };
  controller.tx = { helper: { removeListeners() {} } };
  controller.rx = {
    async stopNotifications() {},
    removeAllListeners() {},
    helper: { removeListeners() {} },
  };
  controller.connectOnce = async () => {
    reconnects += 1;
    controller.connected = true;
    controller.device = { async isConnected() { return true; } };
    controller.tx = {};
    controller.rx = {};
  };

  await controller.checkConnectionHealth();

  assert.equal(connectionChecks, 1);
  assert.equal(reconnects, 1);
  assert.equal(controller.connected, true);
});

test('starts and stops the hourly Bluetooth health-check timer', async () => {
  const controller = new SleepysBedController(log);
  controller.ensureConnected = async () => {};

  await controller.start();

  assert.ok(controller.healthCheckTimer);

  await controller.shutdown();

  assert.equal(controller.healthCheckTimer, null);
});

test('carries a command through a recoverable connection failure', async () => {
  const controller = new SleepysBedController(log);
  const frame = Buffer.from('5A0103103074A5', 'hex');
  const connectionError = new Error('le-connection-abort-by-local');
  let connectionAttempts = 0;
  let writes = 0;

  controller.ensureConnected = async () => {
    connectionAttempts += 1;

    if (connectionAttempts === 1) {
      throw connectionError;
    }

    controller.connected = true;
    controller.device = { async isConnected() { return true; } };
    controller.rx = {};
    controller.tx = {
      async writeValueWithoutResponse(retriedFrame) {
        assert.deepEqual(retriedFrame, frame);
        writes += 1;
      },
    };
  };

  await controller.writeFrame(frame);

  assert.equal(connectionAttempts, 2);
  assert.equal(writes, 1);
});

test('only attempts one immediate recovery for a failed command', async () => {
  const controller = new SleepysBedController(log);
  const connectionError = new Error('le-connection-abort-by-local');
  let connectionAttempts = 0;

  controller.ensureConnected = async () => {
    connectionAttempts += 1;
    throw connectionError;
  };

  await assert.rejects(
    controller.writeFrame(Buffer.from('5A0103103074A5', 'hex')),
    /le-connection-abort-by-local/,
  );

  assert.equal(connectionAttempts, 2);
  assert.equal(controller.recoveryPromise, null);
});

test('does not immediately retry an unrelated connection failure', async () => {
  const controller = new SleepysBedController(log);
  let connectionAttempts = 0;

  controller.ensureConnected = async () => {
    connectionAttempts += 1;
    throw new Error('bed unavailable');
  };

  await assert.rejects(
    controller.writeFrame(Buffer.from('5A0103103074A5', 'hex')),
    /bed unavailable/,
  );

  assert.equal(connectionAttempts, 1);
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

test('times out a stuck command write, reconnects, and retries once', async () => {
  const controller = new SleepysBedController(log, {
    operationTimeoutMs: 10,
  });
  const frame = Buffer.from('5A0103103073A5', 'hex');
  const oldTx = {
    async writeValueWithoutResponse() {
      return new Promise(() => {});
    },
    helper: { removeListeners() {} },
  };

  controller.connected = true;
  controller.device = {
    async isConnected() {
      return true;
    },
    async disconnect() {},
    removeAllListeners() {},
    helper: { removeListeners() {} },
  };
  controller.tx = oldTx;
  controller.rx = {
    async stopNotifications() {},
    removeAllListeners() {},
    helper: { removeListeners() {} },
  };

  let reconnects = 0;
  let retries = 0;
  controller.connectOnce = async () => {
    reconnects += 1;
    controller.connected = true;
    controller.device = { async isConnected() { return true; } };
    controller.rx = {};
    controller.tx = {
      async writeValueWithoutResponse(retriedFrame) {
        assert.deepEqual(retriedFrame, frame);
        retries += 1;
      },
    };
  };

  await controller.writeFrame(frame);

  assert.equal(reconnects, 1);
  assert.equal(retries, 1);
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

function simulateConnected(controller, writes) {
  controller.connected = true;
  controller.device = { async isConnected() { return true; }, async disconnect() {} };
  controller.rx = { async stopNotifications() {} };
  controller.tx = {
    async writeValueWithoutResponse(frame) { writes.push(frame.toString('hex')); },
  };
}

for (const message of ["Sleepy's Elite not found", 'Device not found']) {
  test(`retries the original command once after ${message}`, async () => {
    const controller = new SleepysBedController(log);
    const writes = [];
    let attempts = 0;
    controller.ensureConnected = async () => {
      if (++attempts === 1) throw new Error(message);
      simulateConnected(controller, writes);
    };
    await controller.setLightPower(false);
    assert.equal(attempts, 2);
    assert.deepEqual(writes, ['5a0103103074a5']);
    assert.equal(controller.pendingLightCommands.size, 0);
  });
}

function simulateUnavailable(controller) {
  controller.ensureConnected = async () => { throw new Error("Sleepy's Elite not found"); };
  controller.scheduleReconnect = () => {};
}

test('replays a failed light OFF after background reconnection', async () => {
  const controller = new SleepysBedController(log);
  simulateUnavailable(controller);
  await assert.rejects(controller.setLightPower(false), /not found/);
  assert.equal(controller.pendingLightCommands.size, 1);
  const writes = [];
  controller.ensureConnected = async () => simulateConnected(controller, writes);
  await controller.flushPendingLightCommands();
  assert.deepEqual(writes, ['5a0103103074a5']);
  assert.equal(controller.pendingLightCommands.size, 0);
});

test('background reconnect automatically flushes retained lighting', async () => {
  const controller = new SleepysBedController(log, { reconnectDelaysMs: [1] });
  controller.ensureConnected = async () => { throw new Error('Device not found'); };
  await assert.rejects(controller.setLightPower(false), /not found/);
  let transmitted;
  const sent = new Promise((resolve) => { transmitted = resolve; });
  controller.ensureConnected = async () => {
    controller.connected = true;
    controller.tx = { async writeValueWithoutResponse(frame) { transmitted(frame.toString('hex')); } };
  };
  assert.equal(await sent, '5a0103103074a5');
  await controller.writeQueue;
  await controller.shutdown();
});

test('retains power, brightness and color in order when ON fails', async () => {
  const controller = new SleepysBedController(log);
  simulateUnavailable(controller);
  const requests = await Promise.allSettled([
    controller.setLightPower(true),
    controller.set('led', 33),
    controller.setColor(255, 68, 0),
  ]);
  assert.ok(requests.every((result) => result.status === 'rejected'));
  const writes = [];
  controller.ensureConnected = async () => simulateConnected(controller, writes);
  await controller.flushPendingLightCommands();
  assert.deepEqual(writes, ['5a0103103073a5', '5ae00400020000a5', '5ae00402ff4400a5']);
});

test('newer OFF cancels retained color and brightness that could turn LEDs on', async () => {
  const controller = new SleepysBedController(log);
  simulateUnavailable(controller);
  await assert.rejects(controller.setColor(255, 0, 0), /not found/);
  await assert.rejects(controller.set('led', 67), /not found/);
  await assert.rejects(controller.setLightPower(false), /not found/);
  const writes = [];
  controller.ensureConnected = async () => simulateConnected(controller, writes);
  await controller.flushPendingLightCommands();
  assert.deepEqual(writes, ['5a0103103074a5']);
});

test('only the latest retained brightness is replayed', async () => {
  const controller = new SleepysBedController(log);
  simulateUnavailable(controller);
  await assert.rejects(controller.set('led', 17), /not found/);
  await assert.rejects(controller.set('led', 83), /not found/);
  const writes = [];
  controller.ensureConnected = async () => simulateConnected(controller, writes);
  await controller.flushPendingLightCommands();
  assert.deepEqual(writes, ['5ae00400050000a5']);
});

test('OFF supersedes a color request waiting for Bluetooth without writing it', async () => {
  const controller = new SleepysBedController(log);
  const writes = [];
  let releaseConnection;
  const connection = new Promise((resolve) => { releaseConnection = resolve; });
  controller.ensureConnected = async () => {
    await connection;
    simulateConnected(controller, writes);
  };
  const color = controller.setColor(255, 0, 0);
  await nextTurn();
  const off = controller.setLightPower(false);
  releaseConnection();
  assert.deepEqual(await color, { sent: false, reason: 'superseded' });
  await off;
  assert.deepEqual(writes, ['5a0103103074a5']);
});

test('lighting expires instead of replaying after a long outage', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const controller = new SleepysBedController(log, { lightRecoveryWindowMs: 100 });
  simulateUnavailable(controller);
  await assert.rejects(controller.setLightPower(false), /not found/);
  now = 1100;
  const writes = [];
  controller.ensureConnected = async () => simulateConnected(controller, writes);
  await controller.flushPendingLightCommands();
  assert.deepEqual(writes, []);
  assert.equal(controller.pendingLightCommands.size, 0);
});

test('a motor request that expires during reconnection never reaches the bed', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const controller = new SleepysBedController(log, { motorRequestWindowMs: 100 });
  const writes = [];
  controller.ensureConnected = async () => {
    now = 1100;
    simulateConnected(controller, writes);
  };
  await assert.rejects(controller.set('head', 40), /expired before transmission/);
  assert.deepEqual(writes, []);
  assert.equal(controller.connected, true);
  assert.equal(controller.motorBusy, false);
  assert.equal(controller.motorTimeout, null);
  assert.equal(controller.reconnectTimer, null);
});

test('queued motor requests retain their original expiry', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const controller = new SleepysBedController(log, { motorRequestWindowMs: 100 });
  const writes = [];
  controller.ensureConnected = async () => simulateConnected(controller, writes);
  await controller.set('head', 25);
  await controller.set('feet', 40);
  now = 2100;
  controller.releaseMotor('target');
  await nextTurn();
  assert.equal(writes.length, 1);
  assert.equal(controller.pendingMotorCommands.size, 0);
  assert.equal(controller.motorBusy, false);
});

test('motor movement timer starts after transmission, not during discovery', async () => {
  const controller = new SleepysBedController(log);
  const writes = [];
  let releaseConnection;
  const connection = new Promise((resolve) => { releaseConnection = resolve; });
  controller.ensureConnected = async () => {
    await connection;
    simulateConnected(controller, writes);
  };
  const moving = controller.set('head', 25);
  await nextTurn();
  assert.equal(controller.motorBusy, true);
  assert.equal(controller.motorTimeout, null);
  controller.handleNotification(Buffer.from([0xa5, 0x0d, 0, 0, 25, 0, 0, 0, 0]));
  assert.equal(controller.motorBusy, true);
  releaseConnection();
  await moving;
  assert.ok(controller.motorTimeout);
  controller.releaseMotor('shutdown');
});

test('shutdown discards retained lighting and prevents replay', async () => {
  const controller = new SleepysBedController(log);
  simulateUnavailable(controller);
  await assert.rejects(controller.setLightPower(true), /not found/);
  await controller.shutdown();
  const writes = [];
  controller.ensureConnected = async () => simulateConnected(controller, writes);
  await controller.flushPendingLightCommands();
  assert.deepEqual(writes, []);
  assert.equal(controller.pendingLightCommands.size, 0);
});

test('an expired motor write failure still starts background connection recovery', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const controller = new SleepysBedController(log, { motorRequestWindowMs: 100 });
  let backgroundRecoveries = 0;
  controller.scheduleReconnect = () => { backgroundRecoveries += 1; };
  controller.ensureConnected = async () => {
    controller.connected = true;
    controller.tx = {
      async writeValueWithoutResponse() { now = 1100; throw staleError; },
    };
  };
  await assert.rejects(controller.set('feet', 40), /expired before transmission/);
  assert.ok(backgroundRecoveries > 0);
  assert.equal(controller.connected, false);
  assert.equal(controller.motorBusy, false);
  assert.equal(controller.pendingMotorCommands.size, 0);
});
