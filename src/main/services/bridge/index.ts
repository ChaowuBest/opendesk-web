/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 *
 * OpenDesk 原生桥（Electron 主进程 ↔ ArkTS EtsBridge）
 */

export { IpcChannels, EtsBridgeMethods, RENDERER_BRIDGE_GLOBAL } from './constants.js';
export { callArkTSFunction, unwrapArkTSValue, isOpenHarmonyPlatform } from './arktsClient.js';
export type { ArkTSReturnType } from './arktsClient.js';
export { createNativeBridgeHandlers } from './handlers.js';
export type { NativeBridgeHandler } from './handlers.js';
export { registerNativeBridge } from './registerMain.js';
