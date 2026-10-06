import { describe, expect, test, beforeAll, afterAll, jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 日志目录指向独立临时目录，验证文件 transport 的懒创建且不污染真实用户日志目录；
// 目录可切换，用于覆盖 CLI setCustomOpendeskDirectory 后的重建场景
const dirA = path.join(os.tmpdir(), `opendesk-logger-lazy-a-${process.pid}`);
const dirB = path.join(os.tmpdir(), `opendesk-logger-lazy-b-${process.pid}`);
let logDir = dirA;

jest.unstable_mockModule('../../main/utils/setting.js', () => ({
    getLogDirectory: () => logDir
}));

// 动态导入被测模块，确保日志目录 mock 先于 logger 加载生效
const { logger, getLogFilename, reloadLoggerFileTransport } = await import('../../main/utils/logger.js');

function currentLogFile(): string {
    return path.join(logDir, getLogFilename());
}

async function waitForFileContent(file: string, fragment: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let content = '';
    while (Date.now() < deadline) {
        if (fs.existsSync(file)) {
            content = fs.readFileSync(file, 'utf8');
            if (content.includes(fragment)) return content;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return content;
}

describe('logger file transport lazy creation', () => {
    beforeAll(() => {
        // mock 后的 getLogDirectory 不再负责建目录，测试自行准备
        fs.mkdirSync(dirA, { recursive: true });
    });

    afterAll(() => {
        for (const t of [...logger.transports]) {
            logger.remove(t);
            (t as any).close?.();
        }
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    });

    test('importing logger does not create any log file', () => {
        expect(logger.transports.length).toBeGreaterThan(0);
        expect(fs.existsSync(currentLogFile())).toBe(false);
    });

    test('reloadLoggerFileTransport stays side-effect free before first log', () => {
        expect(reloadLoggerFileTransport()).toBe(currentLogFile());
        expect(fs.existsSync(currentLogFile())).toBe(false);
    });

    test('first log activates the file transport and persists the entry', async () => {
        logger.info('lazy-activation-probe');
        const content = await waitForFileContent(currentLogFile(), 'lazy-activation-probe');
        expect(content).toContain('lazy-activation-probe');
    });

    test('subsequent logs are written exactly once', async () => {
        logger.info('lazy-once-probe');
        await waitForFileContent(currentLogFile(), 'lazy-once-probe');
        // 再留一个事件循环拍，确认懒 transport 自移除前没有造成重复写入
        await new Promise((resolve) => setTimeout(resolve, 150));
        const content = fs.readFileSync(currentLogFile(), 'utf8');
        expect(content.split('lazy-once-probe')).toHaveLength(2);
    });

    test('switching log directory rebuilds the file transport on next log', async () => {
        expect(fs.existsSync(currentLogFile())).toBe(true);

        logDir = dirB;
        fs.mkdirSync(dirB, { recursive: true });
        expect(reloadLoggerFileTransport()).toBe(currentLogFile());

        logger.info('dir-b-probe');
        const contentB = await waitForFileContent(currentLogFile(), 'dir-b-probe');
        expect(contentB).toContain('dir-b-probe');
    });
});
