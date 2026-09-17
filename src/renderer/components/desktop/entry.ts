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

// 副作用导入：模块加载时完成 customElements.define('immersive-desktop')
import './immersiveDesktop.js';
import type { ImmersiveDesktop } from './immersiveDesktop.js';
import { playParticleBurst } from './desktopEffects.js';

let activeDesktop: ImmersiveDesktop | null = null;

/** 打开沉浸桌面（幂等）：先播放粒子动效，再挂载并展开桌面。 */
export async function openImmersiveDesktop(): Promise<void> {
    if (activeDesktop?.isConnected) return;
    playParticleBurst();
    const desktop = document.createElement('immersive-desktop') as ImmersiveDesktop;
    document.body.appendChild(desktop);
    activeDesktop = desktop;
    try {
        await desktop.open();
    } catch (error) {
        console.warn('failed to open immersive desktop', error);
    }
}

/** 关闭沉浸桌面并回到标准主界面。 */
export function closeImmersiveDesktop(): void {
    if (!activeDesktop?.isConnected) {
        activeDesktop = null;
        return;
    }
    activeDesktop.close();
    activeDesktop = null;
}

declare global {
    interface Window {
        openDeskDesktop?: {
            open: () => Promise<void>;
            close: () => void;
        };
    }
}

globalThis.window.openDeskDesktop = {
    open: openImmersiveDesktop,
    close: closeImmersiveDesktop
};
