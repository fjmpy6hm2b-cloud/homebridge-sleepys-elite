const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function installCommandRecovery(SleepysBedController) {
  const prototype = SleepysBedController.prototype;

  if (prototype.__commandRecoveryInstalled) {
    return;
  }

  const originalWriteFrameNow = prototype.writeFrameNow;

  prototype.writeFrameNow = async function writeFrameNowWithConnectionRecovery(frame) {
    const retryDelays = Array.isArray(this.reconnectDelaysMs) &&
      this.reconnectDelaysMs.length > 0
      ? this.reconnectDelaysMs
      : [1000, 2000, 5000, 10000, 30000];

    let retryAttempt = 0;

    while (true) {
      try {
        return await originalWriteFrameNow.call(this, frame);
      } catch (error) {
        // bedController already reconnects and retries once when the GATT write
        // itself goes stale. This outer loop covers the earlier failure mode:
        // ensureConnected() can fail before the frame reaches the write path.
        // Keep the exact same frame pending while bounded reconnect attempts run
        // instead of dropping the HomeKit command and reconnecting without it.
        if (this.stopping || !this.isStaleConnectionError(error)) {
          throw error;
        }

        if (retryAttempt >= retryDelays.length) {
          throw error;
        }

        const delayMs = retryDelays[Math.min(
          retryAttempt,
          retryDelays.length - 1,
        )];
        retryAttempt += 1;

        this.log.debug(
          `Pending Bluetooth command retained after connection failure (${error.message}); retrying in ${delayMs}ms (${retryAttempt}/${retryDelays.length}).`,
        );

        // ensureConnected()/writeFrameNow normally clean failed sessions already,
        // but force a fresh BlueZ/GATT session before the next attempt. Cleanup is
        // best-effort here so a stale StopNotify/Disconnect object cannot discard
        // the pending command.
        try {
          await this.cleanupConnection({ forgetDevice: true });
        } catch (cleanupError) {
          this.log.debug(
            `Bluetooth cleanup during command recovery failed: ${cleanupError.message}`,
          );
        }

        await sleep(delayMs);
      }
    }
  };

  Object.defineProperty(prototype, '__commandRecoveryInstalled', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
