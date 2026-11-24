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

import { BaseApplication } from '../base.js';
import { translateWithDomain } from '../../../locale/index.js';
import { translations } from './locale.js';
import { GlobalState } from '../../aikernel/states/global.js';
import {
    createInteractionDeliveryRuntime,
    type InteractionDeliveryRuntime
} from '../../aikernel/interaction/delivery.js';
import {
    createMobileHostLifecycle,
    type MobileHostPlan,
    type MobileLifecycleOptions
} from './acp/mobile/hosts/lifecycle.js';

import { createInteractionSessionScopeResolver } from './acp/mobile/remote-session-service/session-projector.js';

// Symbol keys keep host capabilities outside the string-addressed application IPC surface.
export const mobileInteractionRuntime = Symbol('mobile interaction runtime');
export const attachMobileHost = Symbol('attach mobile host');

export class MobileAccessApplication extends BaseApplication {
    readonly [mobileInteractionRuntime]: InteractionDeliveryRuntime;
    #run?: ReturnType<typeof createMobileHostLifecycle>;
    #exiting = false;

    constructor() {
        super('mobileaccess', false);
        this[mobileInteractionRuntime] = createInteractionDeliveryRuntime(
            createInteractionSessionScopeResolver(() => GlobalState.getInstance().taskManagerState.getTaskList())
        );
    }

    getName(): string {
        return translateWithDomain('name', translations, undefined, undefined, 'mobileaccess');
    }

    [attachMobileHost](plan: MobileHostPlan, options?: MobileLifecycleOptions): void {
        if (this.#run || this.#exiting) return;
        this.#run = createMobileHostLifecycle(options);
        this.#run.start(plan);
    }

    override async beforeExit(): Promise<void> {
        this.#exiting = true;
        await this.#run?.close();
    }
}
