# Changelog

## 1.2.8 — 2026-10-14

- Combine related HomeKit power, color, and brightness updates over a 700 ms window so an explicit brightness replaces the remembered startup brightness.
- Share the OFF command between power-off and brightness-zero requests, suppressing duplicate successful OFF writes within two seconds.
- Keep color-first startup and Bluetooth recovery; OFF immediately cancels pending lighting updates.

## 1.2.7 — 2026-10-14

- Turn on the under-bed light directly in its selected RGB color, then restore brightness, avoiding the separate ON command that resets the LEDs to white.
- Preserve lighting recovery and cancel older retained OFF requests when turning the light back on.

## 1.2.6 — 2026-10-11

- Reconnect and retry once for bed/device discovery failures as well as stale GATT failures.
- Retain the latest requested lighting state for up to two minutes during background recovery; newer OFF requests cancel older brightness/RGB writes.
- Expire untransmitted motor requests after 15 seconds, and start the movement timeout only after transmission.
- Add optional Bluetooth debug logging for discovery, timed operations, reconnect backoff, and lighting replay.

## 1.2.5 — 2026-09-09

- Ask BlueZ for the bed's connection status once per hour and reconnect only when the cached link is no longer healthy.
- Keep the original HomeKit command through a recoverable connection/setup failure, reconnect immediately, and retry that command once.

## 1.2.4 — 2026-08-31

- Add hard deadlines to BlueZ discovery, connection, GATT setup, command writes, and cleanup so a stalled D-Bus call cannot stop background recovery.
- Remove stale, unpaired bed records through BlueZ after failed setup or disconnect cleanup, then rediscover the controller on a fresh D-Bus session.
- Recover immediately from local BLE connection aborts, ATT `0x0e` failures, and plugin-level Bluetooth operation timeouts.
- Back off repeated reconnect attempts from 1 to 30 seconds instead of retrying continuously at a fixed rate.
- Keep Bluetooth adapter power management outside the plugin; adapter resets remain a manual recovery action.
- Expand regression coverage for stalled discovery, stalled writes, stalled disconnects, stale-device removal, and reconnect backoff.

## 1.2.3 — 2026-08-23

- Reset the complete `node-ble` D-Bus session after failed or stale connections so hidden GATT listeners cannot accumulate.
- Recover cleanly when BlueZ or the Bluetooth adapter is unavailable during initialization.
- Serialize BLE writes so restored HomeKit motor, power, brightness, and color states cannot overlap.
- Bound each connection attempt and continue reconnecting in the background instead of leaving commands pending forever.
- Queue motor-zone requests and send them in order while preserving one-motor-at-a-time operation.
- Reflect physical-remote RGB changes in HomeKit and restore the last nonzero light brightness after power-on.
- Await controller cleanup during Homebridge shutdown.
- Expand regression coverage for connection, listener, write-order, motor-queue, color, and brightness behavior.

## 1.2.2 — 2026-08-23

- Detect stale BlueZ connections before sending commands.
- Reconnect immediately and retry the original motor or lighting command once when its GATT characteristic has disappeared.
- Clean up obsolete `valuechanged` and D-Bus `PropertiesChanged` listeners during scanning, failed connections, reconnects, and shutdown.
- Preserve the existing motor, light, brightness, and RGB command behavior.
