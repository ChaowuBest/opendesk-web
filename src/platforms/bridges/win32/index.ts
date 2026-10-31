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

import { app } from 'electron';
import { NaiveNativeBridge, guardStartupKit, type NativeBridge, type QuickCaptureKit } from '../common.js';
import { WindowsStartupKit } from './startup.js';
import { WindowsQuickCaptureKit } from './quickcapture.js';

class WindowsNativeBridge extends NaiveNativeBridge {
    constructor() {
        super(guardStartupKit(new WindowsStartupKit(app), 'toggle'));
    }

    // 覆盖基类的 Naive 实现：字段初始化在 super() 之后执行，不会被基类默认值盖回。
    _quickCaptureKit: QuickCaptureKit = new WindowsQuickCaptureKit();
}

export function getNativeBridge(): NativeBridge {
    return new WindowsNativeBridge();
}
