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

import { TaskManagerState, TaskState } from './tasks.js';


/**
 * @property {TaskManagerState} taskManagerState
 */
class GlobalState {

    constructor () {
        this.taskManagerState = new TaskManagerState();
    }

    static initialize() {
        this.getInstance();
    }

    /**
     * Get the unique global state instance
     * @returns {GlobalState}
     */
    static getInstance () {
        if (!GlobalState.instance) {
            let existingGlobalState = GlobalState.load();
            if (existingGlobalState !== null) {
                GlobalState.instance = existingGlobalState;
            } else {
                console.info('creating new global state instance')
                GlobalState.instance = new GlobalState();
            }
        }

        return GlobalState.instance;
    }

    static load() {
        let taskManagerState = TaskManagerState.load();
        if (taskManagerState === null) {
            return null;
        }

        var globalState = new GlobalState();
        globalState.taskManagerState = taskManagerState;
        return globalState;
    }
}

export { GlobalState };