import assert from 'node:assert/strict';
import test from 'node:test';

import { installCommandRecovery } from '../commandRecovery.js';

const staleError = new Error('le-connection-abort-by-local');

class FakeController {
  constructor() {
    this.stopping = false;
    this.reconnectDelaysMs = [1, 1, 1];
    this.log = { debug() {} };
    this.attempts = 0;
    this.cleanupCalls = 0;
    this.frames = [];
  }

  isStaleConnectionError(error) {
    return error === staleError;
  }

  async cleanupConnection() {
    this.cleanupCalls += 1;
  }

  async writeFrameNow(frame) {
    this.attempts += 1;
    this.frames.push(Buffer.from(frame));

    if (this.attempts < 3) {
      throw staleError;
    }

    return { sent: true };
  }
}

installCommandRecovery(FakeController);

test('keeps the same command pending across reconnect attempts', async () => {
  const controller = new FakeController();
  const frame = Buffer.from('5A0103103074A5', 'hex');

  const result = await controller.writeFrameNow(frame);

  assert.deepEqual(result, { sent: true });
  assert.equal(controller.attempts, 3);
  assert.equal(controller.cleanupCalls, 2);
  assert.equal(controller.frames.length, 3);

  for (const attemptedFrame of controller.frames) {
    assert.deepEqual(attemptedFrame, frame);
  }
});

test('does not retry unrelated command failures', async () => {
  const unrelatedError = new Error('permission denied');

  class UnrelatedFailureController extends FakeController {
    isStaleConnectionError() {
      return false;
    }

    async writeFrameNow() {
      this.attempts += 1;
      throw unrelatedError;
    }
  }

  installCommandRecovery(UnrelatedFailureController);

  const controller = new UnrelatedFailureController();

  await assert.rejects(
    controller.writeFrameNow(Buffer.from([0x01])),
    /permission denied/,
  );

  assert.equal(controller.attempts, 1);
  assert.equal(controller.cleanupCalls, 0);
});

test('stops retrying after the configured reconnect attempts are exhausted', async () => {
  class AlwaysStaleController extends FakeController {
    async writeFrameNow(frame) {
      this.attempts += 1;
      this.frames.push(Buffer.from(frame));
      throw staleError;
    }
  }

  installCommandRecovery(AlwaysStaleController);

  const controller = new AlwaysStaleController();
  controller.reconnectDelaysMs = [1, 1];

  await assert.rejects(
    controller.writeFrameNow(Buffer.from([0x02])),
    /le-connection-abort-by-local/,
  );

  assert.equal(controller.attempts, 3);
  assert.equal(controller.cleanupCalls, 2);
});
