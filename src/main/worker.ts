/**
 * 工作线程入口文件
 * 这个文件是Electron平台特有的，用于初始化工作线程。CLI端的工作线程和主进程合并在了同一个文件中
 */

import { initializeAppWorkers } from './applications/worker';
import { setPlatform } from '../platforms/base.js';
import { ElectronPlatform } from '../platforms/electron.js';

setPlatform(new ElectronPlatform());
initializeAppWorkers();