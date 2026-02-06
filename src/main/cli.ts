import { setPlatform, getPlatform } from '../platforms/base.js';
import { CliPlatform } from '../platforms/cli.js';
import { mainloop } from './tui/mainloop.js';
import { ApplicationRegistry, initializeRegistry } from './applications/registry.js';


setPlatform(CliPlatform);
initializeRegistry();

mainloop();