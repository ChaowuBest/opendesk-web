/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 *
 * filemgr harness 的统一入口 -- 汇集各子模块的全局钩子注册。
 * 在 filemgr 应用启动时导入本模块即可自动注册全部 harness 钩子。
 */

import './circuit-breaker.js';

import { HookRegistry } from '../../../aikernel/hooks.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';

// 任务回退时清除文件读取缓存，避免"文件未变化"误判导致内容缺失。
HookRegistry.onTaskRevert((task: TaskState) => {
    task.resetFileReadState();
});
