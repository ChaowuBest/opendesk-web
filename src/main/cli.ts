import { setPlatform, getPlatform } from '../platforms/base';
import { isMainThread } from 'worker_threads';
import { CliPlatform } from '../platforms/cli.js';
import { mainloop } from './tui/mainloop.js';
import { devBanner, stdBanner } from './tui/banners.js';
import { initializeRegistry, initializeRegistryWorker } from './applications/registry';
import { initializeAppWorkers } from './applications/worker';


async function main() {
    setPlatform(CliPlatform);
    if (isMainThread) {
        process.stdout.write(stdBanner);
        initializeRegistry();
        initializeRegistryWorker();
        mainloop();
    } else {
        initializeAppWorkers();
    }
}

main();