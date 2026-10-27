/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

'use strict';

// Jest 的 node 环境会把 process 深拷贝进 vm（见 jest-util createProcessObject），
// 测试内对 process.env 的修改对 child_process 的 PATH 查找不可见，导致依赖
// "改 PATH 劫持外部命令" 的测试跑到真实命令上。该环境把 vm 内 process.env
// 换成宿主真实 env 的读写代理，使测试写入能被 spawn 的子进程看到；
// teardown 时按构造时快照还原真实 env，避免污染同 worker 的后续测试文件。

const StableTimerGlobalsEnvironment = require('./stable-timer-environment.js');

class RealProcessEnvEnvironment extends StableTimerGlobalsEnvironment {
    constructor(config, context) {
        super(config, context);
        const realEnv = globalThis.process.env;
        this.envSnapshot = { ...realEnv };
        this.global.process.env = new Proxy(realEnv, {
            get: (target, key) => Reflect.get(target, key),
            set: (target, key, value) => {
                Reflect.set(target, key, value);
                return true;
            },
            deleteProperty: (target, key) => {
                Reflect.deleteProperty(target, key);
                return true;
            }
        });
    }

    async teardown() {
        const realEnv = globalThis.process.env;
        for (const key of Object.keys(realEnv)) {
            if (!(key in this.envSnapshot)) {
                Reflect.deleteProperty(realEnv, key);
            } else if (realEnv[key] !== this.envSnapshot[key]) {
                realEnv[key] = this.envSnapshot[key];
            }
        }
        await super.teardown();
    }
}

module.exports = RealProcessEnvEnvironment;
