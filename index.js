import { SleepysBedController } from './bedController.js';
import { installCommandRecovery } from './commandRecovery.js';
import { SleepysElitePlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

installCommandRecovery(SleepysBedController);

export default (api) => {
  api.registerPlatform(PLATFORM_NAME, SleepysElitePlatform);
};
