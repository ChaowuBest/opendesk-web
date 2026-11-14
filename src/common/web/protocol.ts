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

/**
 * Web 模式浏览器 ↔ main 的 WebSocket 报文与 HTTP 路径约定。
 * 所有 args / 结果均经 ipc-codec 编码。
 */

/** web 模式专用 HTTP 路径前缀，避开 renderer 静态资源的命名空间 */
export const WEB_PREFIX = '/__opendesk';
export const WEB_WS_PATH = `${WEB_PREFIX}/ws`;
export const WEB_PRELOAD_PATH = `${WEB_PREFIX}/web-preload.js`;
/** 本机文件：`${WEB_FS_PATH}/<绝对路径>` */
export const WEB_FS_PATH = `${WEB_PREFIX}/fs`;
/** 自定义协议代理：`${WEB_PROTO_PATH}/<scheme>/<原 URL 的 host+path>` */
export const WEB_PROTO_PATH = `${WEB_PREFIX}/proto`;
export const WEB_UPLOAD_PATH = `${WEB_PREFIX}/upload`;
export const WEB_LIST_PATH = `${WEB_PREFIX}/list`;
export const WEB_MKDIR_PATH = `${WEB_PREFIX}/mkdir`;
export const WEB_HEALTH_PATH = `${WEB_PREFIX}/health`;
export const WEB_LOGIN_PATH = `${WEB_PREFIX}/login`;

/** 服务端注入页面的启动配置（window.__OPENDESK_WEB__） */
export interface WebBootConfig {
    platform: string;
    homePath: string;
    /** 允许经代理访问的自定义协议（不含 ://） */
    schemes: string[];
    /** 上传文件的落盘根目录：`<uploadRoot>/<id>/<文件名>` */
    uploadRoot: string;
}

/** 上传文件名与服务端落盘名一致：去掉路径分隔与控制字符 */
export function sanitizeUploadName(name: string): string {
    // eslint-disable-next-line no-control-regex
    return name.replace(/[\\/\u0000-\u001f]/g, '_').replace(/^\.+$/, '_') || 'upload';
}

export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export type ClientMessage =
    /** ipcRenderer.invoke */
    | { t: 'invoke'; id: number; ch: string; a: unknown }
    /** ipcRenderer.send */
    | { t: 'send'; ch: string; a: unknown }
    /** 对 main 发起的 request 的应答 */
    | { t: 'reply'; id: number; v: unknown };

export type ServerMessage =
    | { t: 'res'; id: number; ok: true; v: unknown }
    | { t: 'res'; id: number; ok: false; e: string }
    /** webContents.send / webFrame.send */
    | { t: 'evt'; ch: string; a: unknown }
    /** main 需要浏览器交互（原生对话框等），浏览器以 reply 应答 */
    | { t: 'req'; id: number; kind: WebRequestKind; p: unknown }
    /** 单向通知：打开 URL、提示错误等 */
    | { t: 'open'; url: string }
    | { t: 'alert'; title: string; message: string };

export type WebRequestKind = 'openDialog' | 'saveDialog' | 'messageBox';

export interface DirectoryListing {
    path: string;
    parent: string | null;
    entries: Array<{ name: string; path: string; directory: boolean }>;
}
