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

'use strict';

// Jest 在 vm + ESM 环境下恢复 fake timers 时可能把全局定时器绑定整个删掉
// （sinon clock.uninstall 的 delete 分支），裸标识符 setInterval/clearInterval
// 随后解析失败，报 "xxx is not defined" 并污染同 worker 内的后续测试。
// 参见 src/tests/ut/aikernel/goal.test.ts 的 restoreRealTimerGlobals 与
// src/tests/ut/renderer/chat-navigation.test.ts 的既有回归测试。
//
// 该环境在每个测试文件加载前：
// 1. 读取一次全局定时器，把 Jest vm global 的 lazy getter 物化为自身数据属性，
//    使 fake timers 安装时能捕获到 hasOwnProperty=true，从源头规避 delete 分支；
// 2. 包装 useRealTimers，恢复后若全局定时器与快照不一致（被删或被换成坏值），
//    自动写回原始函数，避免跨测试污染。

const NodeEnvironment = require('jest-environment-node').TestEnvironment;

const TIMER_GLOBAL_NAMES = [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate'
];

class StableTimerGlobalsEnvironment extends NodeEnvironment {
    constructor(config, context) {
        super(config, context);
        const globalObject = this.global;
        const originalTimers = new Map();
        for (const name of TIMER_GLOBAL_NAMES) {
            originalTimers.set(name, globalObject[name]);
        }

        const patchUseRealTimers = (impl) => {
            if (!impl || typeof impl.useRealTimers !== 'function') {
                return;
            }
            const originalUseRealTimers = impl.useRealTimers.bind(impl);
            impl.useRealTimers = function (...args) {
                const result = originalUseRealTimers(...args);
                for (const name of TIMER_GLOBAL_NAMES) {
                    const original = originalTimers.get(name);
                    if (globalObject[name] === original) {
                        continue;
                    }
                    const descriptor = Object.getOwnPropertyDescriptor(globalObject, name);
                    if (descriptor && !descriptor.configurable) {
                        continue;
                    }
                    Object.defineProperty(globalObject, name, {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value: original
                    });
                }
                return result;
            };
        };

        patchUseRealTimers(this.fakeTimersModern);
        patchUseRealTimers(this.fakeTimers);
    }
}

module.exports = StableTimerGlobalsEnvironment;
