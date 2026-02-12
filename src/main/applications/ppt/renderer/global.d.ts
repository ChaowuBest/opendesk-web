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
 * 应用 iframe 内由 preload 暴露的 applicationAPI（仅当 window.self !== window.top 时存在）
 */
declare global {
  interface Window {
    applicationAPI: {
      call: <T = unknown>(methodName: string, ...args: unknown[]) => Promise<T>;
      callMainWorld: <T = unknown>(methodName: string, ...args: unknown[]) => Promise<T>;
      streamCall: (
        methodName: string,
        callback: (chunk: unknown) => void,
        ...args: unknown[]
      ) => Promise<{ requestId: string }>;
      subscribe: (eventName: string, callback: (...args: unknown[]) => void) => Promise<unknown>;
    };
  }
}

export {};
