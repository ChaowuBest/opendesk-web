/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 工作线程入口文件
 * 这个文件是Electron平台特有的，用于初始化工作线程。CLI端的工作线程和主进程合并在了同一个文件中
 */

import { initializeAppWorkers } from './applications/worker';
import { setPlatform } from '../platforms/base.js';
import { WorkerPlatform } from '../platforms/worker.js';
import { initAgentGateHook } from './agentgate/hook.js';

setPlatform(new WorkerPlatform());
initAgentGateHook();
initializeAppWorkers();
