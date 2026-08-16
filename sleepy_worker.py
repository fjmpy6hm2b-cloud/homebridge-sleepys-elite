import asyncio
import json
import sys
from bleak import BleakClient, BleakScanner

NAME_PREFIX = sys.argv[1] if len(sys.argv) > 1 else "Star25"

TX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
RX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

WAKE = bytes.fromhex("5A0B00A5")
STATUS_QUERY = bytes.fromhex("5AB000A5")

ZONES = {
    "head": 0x00,
    "feet": 0x01,
    "lumbar": 0x02,
}


def emit(event, **data):
    print(json.dumps({"event": event, **data}), flush=True)


class SleepysWorker:
    def __init__(self):
        self.client = None
        self.device = None
        self.connect_lock = asyncio.Lock()
        self.command_queue = asyncio.Queue()
        self.stop_event = asyncio.Event()

        # Latest actual positions reported by the bed.
        self.positions = {
            "head": None,
            "feet": None,
            "lumbar": None,
        }

        # Only one motor movement may be active at a time.
        self.motor_busy = False
        self.motor_zone = None
        self.motor_target = None
        self.motor_done_event = None
        self.motor_watch_task = None

        # Keep the motor lock for at least this long, even if a target packet
        # arrives immediately. This prevents back-to-back motor commands.
        self.motor_min_busy_seconds = 1.0

    def disconnected(self, _client):
        self.client = None
        emit("disconnected")

    def notification_handler(self, _sender, data):
        raw = bytes(data)
        emit("rx", hex=raw.hex(" ").upper())

        # BOX25 position/status packet.
        if len(raw) >= 9 and raw[0] == 0xA5 and raw[1] == 0x0D:
            head = max(0, min(100, raw[4]))
            feet = max(0, min(100, raw[6]))
            lumbar = max(0, min(100, raw[8]))

            self.positions["head"] = head
            self.positions["feet"] = feet
            self.positions["lumbar"] = lumbar

            emit(
                "position",
                head=head,
                feet=feet,
                lumbar=lumbar,
            )

            if (
                self.motor_busy
                and self.motor_done_event is not None
                and self.motor_zone in self.positions
                and self.positions[self.motor_zone] is not None
                and abs(self.positions[self.motor_zone] - self.motor_target) <= 1
            ):
                self.motor_done_event.set()

    async def find_bed(self):
        while not self.stop_event.is_set():
            device = await BleakScanner.find_device_by_filter(
                lambda d, ad: (
                    (d.name or "").startswith(NAME_PREFIX)
                    or (ad.local_name or "").startswith(NAME_PREFIX)
                ),
                timeout=10.0,
            )

            if device is not None:
                return device

            emit("searching")
            await asyncio.sleep(1.0)

        return None

    async def ensure_connected(self):
        if self.client is not None and self.client.is_connected:
            return self.client

        async with self.connect_lock:
            if self.client is not None and self.client.is_connected:
                return self.client

            while not self.stop_event.is_set():
                try:
                    device = await self.find_bed()

                    if device is None:
                        raise asyncio.CancelledError

                    emit("connecting", name=device.name, address=device.address)

                    client = BleakClient(
                        device,
                        disconnected_callback=self.disconnected,
                    )

                    await client.connect()
                    await client.write_gatt_char(TX, WAKE, response=True)
                    await client.start_notify(RX, self.notification_handler)

                    self.device = device
                    self.client = client

                    emit("connected", name=device.name, address=device.address)
                    return client

                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    emit("connect_error", error=str(exc))
                    self.client = None
                    await asyncio.sleep(2.0)

        raise RuntimeError("Worker stopped")

    def build_set_command(self, zone, value):
        value = max(0, min(100, int(value)))

        if zone in ZONES:
            return bytes([
                0x5A,
                0xF0,
                0x03,
                ZONES[zone],
                value,
                0x00,
                0xA5,
            ])

        if zone == "led":
            if value == 0:
                return [
                    bytes.fromhex("5A0103103074A5")
                ]

            level = max(1, round(value * 6 / 100))

            return [
                bytes.fromhex("5A0103103073A5"),
                bytes([
                    0x5A,
                    0xE0,
                    0x04,
                    0x00,
                    level,
                    0x00,
                    0x00,
                    0xA5,
                ]),
            ]

        raise ValueError("zone must be head, feet, lumbar, or led")

    def motor_timeout_for(self, zone, target):
        current = self.positions.get(zone)

        if current is None:
            # We do not yet know how far the motor has to travel.
            return 12.0

        distance = abs(int(target) - int(current))

        # Small moves unlock sooner; large moves get more time.
        # Clamp so a missing notification can never lock the motors forever.
        return max(4.0, min(15.0, 4.0 + distance * 0.12))

    async def watch_motor(self, zone, target, timeout):
        loop = asyncio.get_running_loop()
        started = loop.time()
        reason = "timeout"

        try:
            await asyncio.wait_for(
                self.motor_done_event.wait(),
                timeout=timeout,
            )
            reason = "target"
        except asyncio.TimeoutError:
            reason = "timeout"
        except asyncio.CancelledError:
            raise
        finally:
            elapsed = loop.time() - started

            if elapsed < self.motor_min_busy_seconds:
                await asyncio.sleep(self.motor_min_busy_seconds - elapsed)

            # Only clear the lock if this watcher still owns it.
            if self.motor_zone == zone and self.motor_target == target:
                self.motor_busy = False
                self.motor_zone = None
                self.motor_target = None
                self.motor_done_event = None
                self.motor_watch_task = None

                emit(
                    "motor_ready",
                    zone=zone,
                    target=target,
                    reason=reason,
                )

    async def start_motor(self, client, zone, value):
        if self.motor_busy:
            emit(
                "motor_ignored",
                zone=zone,
                value=value,
                active_zone=self.motor_zone,
                active_target=self.motor_target,
            )
            return

        timeout = self.motor_timeout_for(zone, value)

        self.motor_busy = True
        self.motor_zone = zone
        self.motor_target = value
        self.motor_done_event = asyncio.Event()

        frame = self.build_set_command(zone, value)

        try:
            await client.write_gatt_char(TX, frame, response=False)
        except Exception:
            # Do not leave the motors locked if the write itself failed.
            self.motor_busy = False
            self.motor_zone = None
            self.motor_target = None
            self.motor_done_event = None
            raise

        emit(
            "motor_busy",
            zone=zone,
            target=value,
            timeout=round(timeout, 1),
        )
        emit("sent", cmd="set", zone=zone, value=value)

        self.motor_watch_task = asyncio.create_task(
            self.watch_motor(zone, value, timeout)
        )

    async def execute_command(self, command):
        kind = command.get("cmd")

        if kind == "quit":
            self.stop_event.set()
            return

        client = await self.ensure_connected()

        if kind == "status":
            await client.write_gatt_char(TX, STATUS_QUERY, response=False)
            emit("sent", cmd="status")
            return

        if kind == "set":
            zone = str(command.get("zone", "")).lower()
            value = max(0, min(100, int(command.get("value", 0))))

            if zone in ZONES:
                await self.start_motor(client, zone, value)
                return

            if zone == "led":
                frames = self.build_set_command(zone, value)

                for frame in frames:
                    await client.write_gatt_char(TX, frame, response=False)
                    await asyncio.sleep(0.1)

                emit("sent", cmd="set", zone=zone, value=value)
                return

            raise ValueError("zone must be head, feet, lumbar, or led")

        raise ValueError("cmd must be set, status, or quit")

    async def command_loop(self):
        while not self.stop_event.is_set():
            command = await self.command_queue.get()

            try:
                # One GATT operation at a time. If the connection died, retry
                # the command once after reconnecting.
                try:
                    await self.execute_command(command)
                except Exception as first_exc:
                    emit("command_retry", error=str(first_exc))

                    if self.client is not None:
                        try:
                            await self.client.disconnect()
                        except Exception:
                            pass

                    self.client = None
                    await asyncio.sleep(0.5)
                    await self.execute_command(command)

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                emit("command_error", command=command, error=str(exc))
            finally:
                self.command_queue.task_done()

    async def input_loop(self):
        while not self.stop_event.is_set():
            line = await asyncio.to_thread(sys.stdin.readline)

            if line == "":
                self.stop_event.set()
                return

            line = line.strip()

            if not line:
                continue

            try:
                command = json.loads(line)
                await self.command_queue.put(command)
            except Exception as exc:
                emit("input_error", error=str(exc))

    async def connection_loop(self):
        while not self.stop_event.is_set():
            try:
                await self.ensure_connected()

                while (
                    not self.stop_event.is_set()
                    and self.client is not None
                    and self.client.is_connected
                ):
                    await asyncio.sleep(1.0)

                if not self.stop_event.is_set():
                    emit("reconnecting")
                    await asyncio.sleep(1.0)

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                emit("reconnect_error", error=str(exc))
                await asyncio.sleep(2.0)

    async def run(self):
        emit("starting")

        connect_task = asyncio.create_task(self.connection_loop())
        command_task = asyncio.create_task(self.command_loop())
        input_task = asyncio.create_task(self.input_loop())

        await self.stop_event.wait()

        for task in (connect_task, command_task, input_task):
            task.cancel()

        if self.motor_watch_task is not None:
            self.motor_watch_task.cancel()

        await asyncio.gather(
            connect_task,
            command_task,
            input_task,
            self.motor_watch_task,
            return_exceptions=True,
        )

        if self.client is not None and self.client.is_connected:
            try:
                await self.client.stop_notify(RX)
            except Exception:
                pass

            try:
                await self.client.disconnect()
            except Exception:
                pass

        emit("stopped")


if __name__ == "__main__":
    asyncio.run(SleepysWorker().run())
