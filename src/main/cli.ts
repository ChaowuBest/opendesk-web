import { setPlatform, getPlatform } from '../platforms/base.js';
import { CliPlatform } from '../platforms/cli.js';
import { mainloop } from './tui/mainloop.js';


setPlatform(CliPlatform);

mainloop();