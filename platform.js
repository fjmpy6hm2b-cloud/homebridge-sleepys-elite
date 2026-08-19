import { SleepysElitePlatformAccessory } from './platformAccessory.js';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';

export class SleepysElitePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;
    this.accessories = new Map();
    this.controllers = new Map();

    this.log.debug("Finished initializing Sleepy's Elite platform.");

    this.api.on('didFinishLaunching', () => this.discoverBed());

    this.api.on('shutdown', () => {
      for (const controller of this.controllers.values()) {
        controller.shutdown();
      }
    });
  }

  configureAccessory(accessory) {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverBed() {
    if (!this.config.name || !this.config.deviceNamePrefix) {
      this.log.info(
        "Sleepy's Elite is not configured yet. Add a name and Bluetooth name prefix in plugin settings.",
      );
      return;
    }

    const name = this.config.name;
    const deviceNamePrefix = this.config.deviceNamePrefix;
    const uuid = this.api.hap.uuid.generate(
      `${PLUGIN_NAME}:bed:${deviceNamePrefix}`,
    );

    let accessory = this.accessories.get(uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.deviceNamePrefix = deviceNamePrefix;

      this.api.registerPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        [accessory],
      );

      this.accessories.set(uuid, accessory);
      this.log.info(`Registered new accessory: ${name}`);
    } else {
      accessory.displayName = name;
      accessory.updateDisplayName(name);
      accessory.context.deviceNamePrefix = deviceNamePrefix;
      this.api.updatePlatformAccessories([accessory]);
      this.log.info(`Restoring existing accessory from cache: ${name}`);
    }

    for (const [cachedUuid, cachedAccessory] of this.accessories.entries()) {
      if (cachedUuid === uuid) continue;

      this.log.info(
        `Removing stale accessory from cache: ${cachedAccessory.displayName}`,
      );

      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        [cachedAccessory],
      );

      this.accessories.delete(cachedUuid);
      this.controllers.delete(cachedUuid);
    }

    if (!this.controllers.has(uuid)) {
      this.controllers.set(
        uuid,
        new SleepysElitePlatformAccessory(this, accessory),
      );
    }
  }
}
