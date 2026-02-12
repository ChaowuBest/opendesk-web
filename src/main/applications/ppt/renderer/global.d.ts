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
