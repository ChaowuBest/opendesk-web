import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    RECOVERABLE_REASON_DISPOSAL,
    RECOVERABLE_REASON_EPIPE,
    RECOVERABLE_REASON_HTTP_STATUS,
    isRecoverableMainProcessError,
    logRecoverableMainProcessError,
    resetRecoverableLogState,
    shouldDowngradeRecoverableError
} from '../../../main/utils/recoverable-errors.js';

function withStack(error: Error, stack: string): Error {
    Object.defineProperty(error, 'stack', { value: stack });
    return error;
}

describe('isRecoverableMainProcessError', () => {
    test('识别 Electron 已销毁对象错误（崩溃回归场景）', () => {
        const error = new TypeError('Object has been destroyed');
        expect(isRecoverableMainProcessError(error)).toBe('Electron 对象已销毁/帧已释放');
    });

    test('识别已释放帧错误（大小写不敏感）', () => {
        expect(isRecoverableMainProcessError(new Error('Render frame was disposed'))).not.toBeNull();
        expect(isRecoverableMainProcessError(new Error('WebFrameMain is disposed'))).not.toBeNull();
    });

    test('识别 WebFrameMain 的真实完整文案（访问已释放 frame）', () => {
        expect(
            isRecoverableMainProcessError(new Error('Render frame was disposed before WebFrameMain could be accessed'))
        ).toBe('Electron 对象已销毁/帧已释放');
    });

    test('容忍尾部句号与首尾空白', () => {
        expect(isRecoverableMainProcessError(new Error('  Object has been destroyed.  '))).not.toBeNull();
    });

    test('识别已销毁对象上的 send/isDestroyed 属性访问（堆栈落在 Electron 原生帧）', () => {
        const error = withStack(
            new TypeError("Cannot read properties of undefined (reading 'send')"),
            "TypeError: Cannot read properties of undefined (reading 'send')\n    at WebFrameMain.send (node:electron/js2c/browser_init:2:12345)"
        );
        expect(isRecoverableMainProcessError(error)).toBe('Electron 对象已销毁/帧已释放');
    });

    test('同样的属性访问错误但堆栈不在 Electron 原生帧上时，仍按致命处理', () => {
        const error = withStack(
            new TypeError("Cannot read properties of undefined (reading 'send')"),
            "TypeError: Cannot read properties of undefined (reading 'send')\n    at ApplicationRegistry.emitNoop (/app/registry.js:1:1)"
        );
        expect(isRecoverableMainProcessError(error)).toBeNull();
    });

    test('识别 EPIPE', () => {
        const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
        expect(isRecoverableMainProcessError(error)).toBe('EPIPE (网络/管道断开)');
    });

    test('识别越界 HTTP 状态码', () => {
        const error = new RangeError('Invalid status code: 999');
        Object.defineProperty(error, 'stack', { value: 'at initializeResponse (node:electron/js2c)' });
        expect(isRecoverableMainProcessError(error)).toBe('Out-of-range HTTP status code');
    });

    test('普通异常不视为可恢复', () => {
        expect(isRecoverableMainProcessError(new TypeError('Cannot read properties of undefined'))).toBeNull();
        expect(isRecoverableMainProcessError(new Error('boom'))).toBeNull();
        expect(isRecoverableMainProcessError('string reason')).toBeNull();
        expect(isRecoverableMainProcessError(undefined)).toBeNull();
        expect(isRecoverableMainProcessError(null)).toBeNull();
    });

    test('消息里只是顺带出现销毁文案的异常不会被误吞', () => {
        // 整句匹配：真实异常不该因为日志/提示语里含相同文字就被降级
        expect(
            isRecoverableMainProcessError(new Error('Failed to destroy object has been destroyed marker'))
        ).toBeNull();
        expect(isRecoverableMainProcessError(new Error('destroy the file failed'))).toBeNull();
        expect(
            isRecoverableMainProcessError(new Error('Object has been destroyed, but the write already succeeded'))
        ).toBeNull();
    });
});

describe('shouldDowngradeRecoverableError', () => {
    test('非 debug 模式下所有可恢复错误都降级为告警', () => {
        expect(shouldDowngradeRecoverableError(RECOVERABLE_REASON_DISPOSAL, false)).toBe(true);
        expect(shouldDowngradeRecoverableError(RECOVERABLE_REASON_EPIPE, false)).toBe(true);
        expect(shouldDowngradeRecoverableError(RECOVERABLE_REASON_HTTP_STATUS, false)).toBe(true);
    });

    test('debug 模式下销毁竞态不降级，开发期能立刻暴露调用点', () => {
        expect(shouldDowngradeRecoverableError(RECOVERABLE_REASON_DISPOSAL, true)).toBe(false);
    });

    test('debug 模式下环境性错误仍降级，调试实例不会因终端断开而退出', () => {
        expect(shouldDowngradeRecoverableError(RECOVERABLE_REASON_EPIPE, true)).toBe(true);
        expect(shouldDowngradeRecoverableError(RECOVERABLE_REASON_HTTP_STATUS, true)).toBe(true);
    });
});

describe('logRecoverableMainProcessError', () => {
    beforeEach(() => {
        resetRecoverableLogState();
    });

    test('窗口期内同一指纹只输出一条日志', () => {
        const warn = jest.fn((_message: string) => undefined);

        logRecoverableMainProcessError(warn, 'reason', 'TypeError: boom\n    at a', 1_000);
        logRecoverableMainProcessError(warn, 'reason', 'TypeError: boom\n    at a', 2_000);
        logRecoverableMainProcessError(warn, 'reason', 'TypeError: boom\n    at a', 3_000);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toBe('[RECOVERABLE] reason: TypeError: boom\n    at a');
    });

    test('跨窗口后重新输出并带上被抑制的条数', () => {
        const warn = jest.fn((_message: string) => undefined);

        logRecoverableMainProcessError(warn, 'reason', 'TypeError: boom\n    at a', 0);
        logRecoverableMainProcessError(warn, 'reason', 'TypeError: boom\n    at a', 1_000);
        logRecoverableMainProcessError(warn, 'reason', 'TypeError: boom\n    at a', 61_000);

        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[1][0]).toContain('窗口期内同类错误已抑制 1 条');
    });

    test('不同指纹互不影响', () => {
        const warn = jest.fn((_message: string) => undefined);

        logRecoverableMainProcessError(warn, 'reason', 'TypeError: boom\n    at a', 0);
        logRecoverableMainProcessError(warn, 'reason', 'TypeError: boom\n    at b', 1_000);

        expect(warn).toHaveBeenCalledTimes(2);
    });

    test('指纹数量超过上限时重置缓存，不会无界增长', () => {
        const warn = jest.fn((_message: string) => undefined);

        for (let i = 0; i < 150; i += 1) {
            logRecoverableMainProcessError(warn, 'reason', `TypeError: boom ${i}\n    at a`, i);
        }

        expect(warn).toHaveBeenCalledTimes(150);
    });
});
