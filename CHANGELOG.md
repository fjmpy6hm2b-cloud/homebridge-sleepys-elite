# Changelog

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
