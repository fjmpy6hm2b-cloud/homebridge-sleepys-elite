export function installCommandRecovery(SleepysBedController) {
  const prototype = SleepysBedController.prototype;

  if (prototype.__commandRecoveryInstalled) {
    return;
  }

  const originalWriteFrameNow = prototype.writeFrameNow;

  prototype.writeFrameNow = async function writeFrameNowWithConnectionRecovery(frame) {
    try {
      return await originalWriteFrameNow.call(this, frame);
    } catch (error) {
      // bedController already retries a frame when the GATT write itself goes
      // stale. This outer recovery catches the earlier case where
      // ensureConnected() fails before the frame ever reaches the write path.
      // Keep the same frame pending, rebuild the BLE session, then run the
      // normal write path again instead of dropping the HomeKit command.
      if (this.stopping || !this.isStaleConnectionError(error)) {
        throw error;
      }

      let recoveryError = error;

      try {
        await this.recoverStaleConnection(this.tx, recoveryError);
      } catch (errorDuringRecovery) {
        // A transient connect/setup failure can happen while rebuilding the
        // session. Keep the command alive and let the normal write path make
        // one more bounded connection attempt. Non-transient errors still fail
        // immediately.
        if (
          this.stopping ||
          !this.isStaleConnectionError(errorDuringRecovery)
        ) {
          throw errorDuringRecovery;
        }

        recoveryError = errorDuringRecovery;
        this.log.debug(
          `Command recovery connection attempt failed (${recoveryError.message}); retrying the pending command once more.`,
        );
      }

      return originalWriteFrameNow.call(this, frame);
    }
  };

  Object.defineProperty(prototype, '__commandRecoveryInstalled', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
