import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActiveTaskFileStore } from '../../../main/applications/channelmgr/dispatch/file-store.js';

let tempDirs: string[] = [];

function makeStoreFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odk-active-tasks-'));
    tempDirs.push(dir);
    return path.join(dir, 'nested', 'active_tasks.json');
}

function readFile(filePath: string): { version: number; channels: Record<string, Record<string, any>> } {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

afterEach(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
});

describe('ActiveTaskFileStore 读写', () => {
    test('文件不存在时 load 返回 undefined，不抛错', () => {
        const store = new ActiveTaskFileStore(makeStoreFile());
        expect(store.load('feishu')).toBeUndefined();
    });

    test('save + flush 落盘，新实例可读回（模拟重启）', () => {
        const filePath = makeStoreFile();
        const store = new ActiveTaskFileStore(filePath);
        store.save('feishu', {
            'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 111 },
            'feishu:bot-1:group-1': { taskId: 'task-2', updatedAt: 222 }
        });
        store.flush();

        // 目录不存在时自动创建，且不遗留临时文件
        expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(readFile(filePath)).toEqual({
            version: 1,
            channels: {
                feishu: {
                    'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 111 },
                    'feishu:bot-1:group-1': { taskId: 'task-2', updatedAt: 222 }
                }
            }
        });

        const reopened = new ActiveTaskFileStore(filePath);
        expect(reopened.load('feishu')).toEqual({
            'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 111 },
            'feishu:bot-1:group-1': { taskId: 'task-2', updatedAt: 222 }
        });
    });

    test('只写一个渠道不会覆盖文件里其他渠道的绑定', () => {
        const filePath = makeStoreFile();
        const first = new ActiveTaskFileStore(filePath);
        first.save('feishu', { 'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 1 } });
        first.save('weixin', { 'weixin:bot-9:user-1': { taskId: 'task-9', updatedAt: 2 } });
        first.flush();

        // 新实例只更新 weixin：feishu 的历史绑定必须保留（save 前的懒加载不能丢数据）
        const second = new ActiveTaskFileStore(filePath);
        second.save('weixin', { 'weixin:bot-9:user-1': { taskId: 'task-10', updatedAt: 3 } });
        second.flush();

        const reopened = new ActiveTaskFileStore(filePath);
        expect(reopened.load('feishu')).toEqual({ 'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 1 } });
        expect(reopened.load('weixin')).toEqual({ 'weixin:bot-9:user-1': { taskId: 'task-10', updatedAt: 3 } });
    });

    test('空绑定（清空某渠道）也会落盘', () => {
        const filePath = makeStoreFile();
        const store = new ActiveTaskFileStore(filePath);
        store.save('feishu', { 'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 1 } });
        store.flush();
        store.save('feishu', {});
        store.flush();

        expect(readFile(filePath).channels.feishu).toEqual({});
    });
});

describe('ActiveTaskFileStore 写入合并与容错', () => {
    test('防抖窗口内的多次 save 只落盘一次', async () => {
        const filePath = makeStoreFile();
        const store = new ActiveTaskFileStore(filePath, 20);
        const writeSpy = jest.spyOn(store as unknown as { writeNow: () => void }, 'writeNow');

        store.save('feishu', { 'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 1 } });
        store.save('feishu', { 'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 2 } });
        store.save('weixin', { 'weixin:bot-9:user-1': { taskId: 'task-9', updatedAt: 3 } });
        expect(writeSpy).not.toHaveBeenCalled();

        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(readFile(filePath).channels).toEqual({
            feishu: { 'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 2 } },
            weixin: { 'weixin:bot-9:user-1': { taskId: 'task-9', updatedAt: 3 } }
        });
    });

    test('flush 会取消防抖中的写入，不会重复落盘', async () => {
        const filePath = makeStoreFile();
        const store = new ActiveTaskFileStore(filePath, 20);
        const writeSpy = jest.spyOn(store as unknown as { writeNow: () => void }, 'writeNow');

        store.save('feishu', { 'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 1 } });
        store.flush();
        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(readFile(filePath).channels.feishu).toEqual({
            'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 1 }
        });
    });

    test('文件损坏时按空绑定处理，且后续写入能重建文件', () => {
        const filePath = makeStoreFile();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '{ this is not json', 'utf8');

        const store = new ActiveTaskFileStore(filePath);
        expect(store.load('feishu')).toBeUndefined();

        store.save('feishu', { 'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 1 } });
        store.flush();

        expect(new ActiveTaskFileStore(filePath).load('feishu')).toEqual({
            'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 1 }
        });
    });

    test('文件结构缺 channels 字段时按空绑定处理', () => {
        const filePath = makeStoreFile();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), 'utf8');

        expect(new ActiveTaskFileStore(filePath).load('feishu')).toBeUndefined();
    });

    test('读取失败时禁止覆盖写，不会用空快照抹掉已有绑定', () => {
        const filePath = makeStoreFile();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const original = {
            version: 1,
            channels: { feishu: { 'feishu:bot-1:user-1': { taskId: 'task-1', updatedAt: 1 } } }
        };
        fs.writeFileSync(filePath, JSON.stringify(original), 'utf8');

        const busy = Object.assign(new Error('file is busy'), { code: 'EBUSY' });
        const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((() => {
            throw busy;
        }) as never);
        try {
            const store = new ActiveTaskFileStore(filePath);
            store.save('weixin', { 'weixin:bot-9:user-1': { taskId: 'task-9', updatedAt: 2 } });
            store.flush();
        } finally {
            readSpy.mockRestore();
        }

        // 磁盘内容原样保留（这次绑定只停在内存里，下次启动重新读盘即可）
        expect(readFile(filePath)).toEqual(original);
    });
});
