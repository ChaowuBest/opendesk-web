import { describe, expect, test, beforeAll, afterAll, jest } from '@jest/globals';
import Transport from 'winston-transport';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 日志目录指向系统临时目录，避免测试影响真实用户日志目录
const testLogDir = path.join(os.tmpdir(), `opendesk-logger-level-test-${process.pid}`);

jest.unstable_mockModule('../../main/utils/setting.js', () => ({
    getLogDirectory: () => testLogDir
}));

// 动态导入被测模块，确保日志目录 mock 先于 logger 加载生效
const { logger, setDebugMode, getDebugMode } = await import('../../main/utils/logger.js');

interface CapturedEntry {
    level: string;
    message: any;
}

// logger 的 logFormat 带 colorize()，到达 transport 的 level 带 ANSI 颜色码
// eslint-disable-next-line no-control-regex
const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');

class CaptureTransport extends Transport {
    entries: CapturedEntry[] = [];
    private resolvers: Array<() => void> = [];

    log(info: any, callback: () => void) {
        this.entries.push({ level: stripAnsi(info.level), message: info.message });
        // winston 可能同步调用 log()，resolver 必须在触发日志前挂好
        for (const resolve of this.resolvers.splice(0)) {
            resolve();
        }
        callback();
    }

    // 等待下一条日志；须在触发 logger.xxx() 之前调用
    waitForNext(): Promise<CapturedEntry> {
        return new Promise((resolve) => {
            this.resolvers.push(() => resolve(this.entries[this.entries.length - 1]));
        });
    }
}

describe('logger debug level follows debugMode', () => {
    const capture = new CaptureTransport();

    beforeAll(() => {
        // 移除真实的 file/logstream transports，避免测试写日志文件；
        // close() 释放文件句柄，否则 Windows 下 afterAll 清理临时目录会失败
        for (const t of [...logger.transports]) {
            logger.remove(t);
            (t as any).close?.();
        }
        logger.add(capture);
        setDebugMode(false);
    });

    afterAll(() => {
        logger.remove(capture);
        setDebugMode(false);
        fs.rmSync(testLogDir, { recursive: true, force: true });
    });

    test('debug logs are suppressed at default info level', async () => {
        expect(getDebugMode()).toBe(false);
        expect(logger.level).toBe('info');

        logger.debug('probe-suppressed');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(capture.entries.filter((e) => e.message === 'probe-suppressed')).toHaveLength(0);

        const pending = capture.waitForNext();
        logger.info('probe-info-visible');
        const infoEntry = await pending;
        expect(infoEntry.level).toBe('info');
        expect(infoEntry.message).toBe('probe-info-visible');
    });

    test('enabling debugMode lets logger.debug entries through with debug level', async () => {
        setDebugMode(true);
        expect(getDebugMode()).toBe(true);
        expect(logger.level).toBe('debug');

        const debugPending = capture.waitForNext();
        logger.debug('probe-debug-visible');
        const debugEntry = await debugPending;
        expect(debugEntry.level).toBe('debug');
        expect(debugEntry.message).toBe('probe-debug-visible');

        const warnPending = capture.waitForNext();
        logger.warn('probe-warn');
        const warnEntry = await warnPending;
        expect(warnEntry.level).toBe('warn');
    });

    test('disabling debugMode restores info level filtering', async () => {
        setDebugMode(false);
        expect(logger.level).toBe('info');

        logger.debug('probe-suppressed-again');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(capture.entries.filter((e) => e.message === 'probe-suppressed-again')).toHaveLength(0);
    });
});
