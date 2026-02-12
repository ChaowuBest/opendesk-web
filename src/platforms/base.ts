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

import { BaseApplication } from '../main/applications/base';
import open from 'open';


export abstract class AbstractPlatform {

    getName(): string {
        throw new Error('Not implemented');
    }

    async openPath(filePath: string) {
        await open(filePath);
    }

    async showItemInFolder(filePath: string) {

    }

    getWorkerPath(): string {
        return process.argv[1];
    }

    getApplicationClasses(): typeof BaseApplication[] {
        return [];
    }
}

let __platform: AbstractPlatform | null = null;

export function setPlatform(platform: AbstractPlatform) {
    __platform = platform;
}

export function getPlatform(): AbstractPlatform {
    if (__platform === null) {
        throw new Error('Platform is not set');
    }
    return __platform;
}
