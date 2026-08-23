# Changelog

## 1.2.2 — 2026-08-23

- Detect stale BlueZ connections before sending commands.
- Reconnect immediately and retry the original motor or lighting command once when its GATT characteristic has disappeared.
- Clean up obsolete `valuechanged` and D-Bus `PropertiesChanged` listeners during scanning, failed connections, reconnects, and shutdown.
- Preserve the existing motor, light, brightness, and RGB command behavior.
