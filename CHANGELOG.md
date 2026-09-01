# Changelog

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
