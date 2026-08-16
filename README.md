# homebridge-sleepys-elite

Unofficial Homebridge dynamic-platform plugin for Sleepy's Elite / BOX25 adjustable beds.

## Features

- Head, feet, and lumbar position control
- Under-bed light on/off and brightness
- Persistent Bluetooth worker with automatic reconnect
- Physical-remote position updates reflected in HomeKit
- Debounced slider commands
- One motor movement at a time to prevent overlapping motor commands

## Requirements

- Homebridge 1.8+ or 2.x
- Node.js 22 or 24
- Linux with Bluetooth / BlueZ
- Python 3
- Python package `bleak`

The plugin does not modify the host system during npm installation. Install Bleak into the Python environment Homebridge should use, then set **Python Executable** in the plugin settings if it is not simply `python3`.

Example:

```bash
python3 -m venv ~/sleepys-venv
~/sleepys-venv/bin/pip install bleak
```

Then set **Python Executable** to the full path of that environment's Python binary.

## Configuration

This plugin uses Homebridge's dynamic-platform architecture. Add the **Sleepy's Elite** platform in the Homebridge UI.

The default Bluetooth advertising-name prefix is `Star25`.

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
