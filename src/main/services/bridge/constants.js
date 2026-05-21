/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/** 主进程 ↔ 渲染进程 IPC 通道（opendesk:*） */
export const IpcChannels = {
    PING: 'opendesk:ping',
    SPEECH_INIT: 'opendesk:speechInit',
    SPEECH_START: 'opendesk:speechStart',
    SPEECH_STOP: 'opendesk:speechStop',
    SPEECH_RELEASE: 'opendesk:speechRelease'
};

/** ArkTS EtsBridge 绑定名（与 web_engine JsBinding 一致） */
export const EtsBridgeMethods = {
    PING: 'EtsBridge.OpenDeskPing',
    SPEECH_INIT: 'EtsBridge.OpenDeskSpeechInit',
    SPEECH_START: 'EtsBridge.OpenDeskSpeechStart',
    SPEECH_STOP: 'EtsBridge.OpenDeskSpeechStop',
    SPEECH_RELEASE: 'EtsBridge.OpenDeskSpeechRelease'
};

/** 渲染进程 window 上的桥接对象名 */
export const RENDERER_BRIDGE_GLOBAL = 'opendeskNative';
