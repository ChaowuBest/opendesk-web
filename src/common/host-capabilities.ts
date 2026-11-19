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

// Host support is separate from configured accounts, connected nodes and application readiness.
const hostCapabilities = [
    'systemTrash',
    'workspaceTrash',
    'revealFile',
    'openDirectory',
    'applicationWindows',
    'windowControls',
    'devTools',
    'configDirectory',
    'logWindow',
    'adminWindow',
    'immersiveDesktop',
    'taskStatusWidget'
] as const;
export type HostCapability = (typeof hostCapabilities)[number];

/** Known desktop hosts preserve existing support; other hosts explicitly declare each capability. */
export function isHostCapabilitySupported(platform: string, _capability: HostCapability): boolean {
    return ['win32', 'darwin', 'linux', 'openharmony'].includes(platform);
}

export function getHostCapabilities(
    platform: string,
    declared: Readonly<Partial<Record<HostCapability, boolean>>> = {}
): Readonly<Record<HostCapability, boolean>> {
    return Object.freeze(
        Object.fromEntries(
            hostCapabilities.map((capability) => [
                capability,
                declared[capability] ?? isHostCapabilitySupported(platform, capability)
            ])
        )
    ) as Readonly<Record<HostCapability, boolean>>;
}

const channelCapabilities: Record<string, HostCapability> = {
    'fs:trashItem': 'workspaceTrash',
    'fs:openTrash': 'systemTrash',
    'fs:showItemInFolder': 'revealFile',
    'workspace:openWorkspaceDirectory': 'openDirectory',
    'application:openInNewWindow': 'applicationWindows',
    'setting:minimizeMainWindow': 'windowControls',
    'setting:maximizeMainWindow': 'windowControls',
    'setting:closeMainWindow': 'windowControls',
    'setting:toggleFullScreen': 'windowControls',
    'setting:setFullscreen': 'windowControls',
    'setting:openDevTools': 'devTools',
    'setting:openConfigDirectory': 'configDirectory',
    'setting:openLogWindow': 'logWindow',
    'globalControl:openAdminPanel': 'adminWindow'
};

export function getChannelCapability(channel: string): HostCapability | undefined {
    if (channel.startsWith('desktop:')) return 'immersiveDesktop';
    if (channel.startsWith('taskStatusWidget:')) return 'taskStatusWidget';
    return Object.hasOwn(channelCapabilities, channel) ? channelCapabilities[channel] : undefined;
}
