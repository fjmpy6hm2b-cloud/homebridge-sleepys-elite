# homebridge-sleepys-elite

[![verified-by-homebridge](https://img.shields.io/badge/_-verified-blueviolet?color=%23491F59&style=flat&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

Unofficial Homebridge dynamic-platform plugin for Sleepy's Elite / BOX25 adjustable beds.

## Features

- Head, feet, and lumbar position control
- Under-bed light on/off, 0–100% brightness, and full RGB color control
- Persistent Bluetooth connection with an hourly lightweight connection check, stale-session detection, bounded reconnect backoff, and one-shot command retry
- Hard timeouts for discovery, connection, GATT setup, command writes, and cleanup so stalled BlueZ calls cannot block recovery
- Serialized Bluetooth writes, stale-device removal, and full D-Bus session cleanup on reconnect
- Physical-remote position, light-power, and RGB color updates reflected in HomeKit
- Debounced slider commands
- Queued motor requests with one motor movement at a time
- Latest lighting requests retained for up to two minutes during Bluetooth recovery; OFF cancels older brightness/color requests
- Motor requests expire after 15 seconds if they have not been transmitted, including queued requests
- Native Node.js Bluetooth over BlueZ/D-Bus
- No Python, virtual environment, or Bleak setup

## Requirements

- Homebridge 2.x
- Node.js 22.12+ or 24.x
- Linux/Homebridge host with Bluetooth and BlueZ

On a standard Homebridge Raspberry Pi image, installation is intended to be:

1. Install the plugin in Homebridge.
2. Leave the Bluetooth name prefix as `Star25` unless your bed advertises differently.
3. Save/restart Homebridge.

No Python setup is required.

## Configuration

- **Name:** HomeKit accessory name.
- **Bed Bluetooth Name Prefix:** defaults to `Star25`.
- **Bluetooth Debug Logging:** defaults to off. Enable it and restart the child bridge to show scan durations, connection/setup failures, reconnect delays, and lighting replay in the normal Homebridge log. This does not send diagnostic commands to the bed.

Discovery failures (`Sleepy's Elite not found` / `Device not found`) receive one immediate reconnect-and-retry, like stale GATT failures. If lighting still fails, the latest power, brightness, and color requests can be replayed after background recovery within two minutes of the original request. Later requests replace older requests; turning the light off also cancels older commands that could turn it back on. Requests are discarded at shutdown. Motor requests are never retained for delayed background replay beyond their 15-second transmission window.

## Current status

Tested with a Sleepy's Elite BOX25 controller advertising as `Star25...`.

## Disclaimer

This is an unofficial community project. It is not affiliated with, endorsed by, sponsored by, or supported by Sleepy's or Mattress Firm.

Sleepy's and related names and trademarks are the property of their respective owners. Product names are used only to identify compatibility with this software.

Use this software at your own risk. This project communicates directly with adjustable-bed hardware over Bluetooth and is provided without warranty.

## Credits

This project benefited from Bluetooth protocol research and documentation in the `ha-adjustable-bed` project by Kristoffer R. and its contributors:

https://github.com/kristofferR/ha-adjustable-bed

See `THIRD_PARTY_NOTICES.md` for attribution details.

## License

MIT


### Split-bed systems

The plugin supports one adjustable-base controller per Homebridge plugin instance. Split-bed configurations with two independent controllers are not supported.
