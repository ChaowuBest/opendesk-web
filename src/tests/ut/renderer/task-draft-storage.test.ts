import { afterEach, describe, expect, test } from '@jest/globals';
import {
    clearTaskDraft,
    isTaskDraftEmpty,
    loadTaskDraft,
    saveTaskDraft
} from '../../../renderer/utils/task-draft-storage';

/**
 * localStorage 内存替身：Map 语义 + 可注入的配额故障。
 * Chromium 配额超限抛 DOMException（name === 'QuotaExceededError'），
 * 这里用普通 Error 模拟，模块只依赖"抛错"这一行为。
 */
class FakeStorage {
    private map = new Map<string, string>();
    failWhen: ((key: string, value: string) => boolean) | null = null;

    getItem(key: string): string | null {
        return this.map.has(key) ? this.map.get(key)! : null;
    }
    setItem(key: string, value: string): void {
        if (this.failWhen?.(key, value)) {
            const err = new Error('quota exceeded') as Error & { name: string };
            err.name = 'QuotaExceededError';
            throw err;
        }
        this.map.set(key, value);
    }
    removeItem(key: string): void {
        this.map.delete(key);
    }
    dump(): Record<string, string> {
        return Object.fromEntries(this.map.entries());
    }
}

const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        writable: true,
        configurable: true
    });
});

function installStorage(fake: FakeStorage): FakeStorage {
    Object.defineProperty(globalThis, 'localStorage', { value: fake, writable: true, configurable: true });
    return fake;
}

describe('task-draft-storage', () => {
    test('保存后按 task_id 读取，往返一致', () => {
        const fake = installStorage(new FakeStorage());
        const draft = {
            text: '帮我分析这段日志',
            images: [{ dataUrl: 'data:image/png;base64,AAA', name: 'a.png' }],
            filePaths: ['D:/proj/logs/app.log', 'D:/proj/config.json']
        };
        saveTaskDraft('task-1', draft);
        expect(loadTaskDraft('task-1')).toEqual(draft);
        expect(Object.keys(fake.dump())[0]).toBe('opendesk:task-draft:task-1');
    });

    test('不同 task_id 互不干扰', () => {
        installStorage(new FakeStorage());
        saveTaskDraft('task-1', { text: 'one', images: [], filePaths: [] });
        saveTaskDraft('task-2', { text: 'two', images: [], filePaths: [] });
        expect(loadTaskDraft('task-1')?.text).toBe('one');
        expect(loadTaskDraft('task-2')?.text).toBe('two');
        clearTaskDraft('task-1');
        expect(loadTaskDraft('task-1')).toBeNull();
        expect(loadTaskDraft('task-2')?.text).toBe('two');
    });

    test('空草稿保存时移除记录', () => {
        const fake = installStorage(new FakeStorage());
        saveTaskDraft('task-1', { text: 'x', images: [], filePaths: [] });
        expect(loadTaskDraft('task-1')).not.toBeNull();
        saveTaskDraft('task-1', { text: '   ', images: [], filePaths: [] });
        expect(loadTaskDraft('task-1')).toBeNull();
        expect(Object.keys(fake.dump())).toHaveLength(0);
    });

    test('isTaskDraftEmpty：空白文本且无附件为空', () => {
        expect(isTaskDraftEmpty({ text: '', images: [], filePaths: [] })).toBe(true);
        expect(isTaskDraftEmpty({ text: '  \n ', images: [], filePaths: [] })).toBe(true);
        expect(isTaskDraftEmpty({ text: '', images: [{ dataUrl: 'data:...', name: 'a' }], filePaths: [] })).toBe(false);
        expect(isTaskDraftEmpty({ text: 'draft', images: [], filePaths: [] })).toBe(false);
        expect(isTaskDraftEmpty({ text: '', images: [], filePaths: ['D:/a.txt'] })).toBe(false);
    });

    test('配额不足时降级为仅保存文本与文件路径', () => {
        const fake = installStorage(new FakeStorage());
        fake.failWhen = (_key, value) => value.includes('data:image');
        saveTaskDraft('task-1', {
            text: '重要草稿文本',
            images: [{ dataUrl: 'data:image/png;base64,AAAA', name: 'big.png' }],
            filePaths: ['D:/keep.log']
        });
        const restored = loadTaskDraft('task-1');
        expect(restored?.text).toBe('重要草稿文本');
        expect(restored?.images).toEqual([]);
        expect(restored?.filePaths).toEqual(['D:/keep.log']);
    });

    test('文本本身超限（降级后仍失败）时静默放弃，不抛错', () => {
        const fake = installStorage(new FakeStorage());
        fake.failWhen = () => true;
        expect(() => saveTaskDraft('task-1', { text: 'huge text', images: [], filePaths: [] })).not.toThrow();
        expect(loadTaskDraft('task-1')).toBeNull();
    });

    test('损坏的持久化数据返回 null 而非抛错', () => {
        const fake = installStorage(new FakeStorage());
        fake.setItem('opendesk:task-draft:task-1', '{not-json');
        expect(loadTaskDraft('task-1')).toBeNull();
        fake.setItem('opendesk:task-draft:task-1', JSON.stringify({ noText: true }));
        expect(loadTaskDraft('task-1')).toBeNull();
        fake.setItem(
            'opendesk:task-draft:task-1',
            JSON.stringify({ text: 't', images: [{ broken: true }, { dataUrl: 'data:x', name: 'n' }] })
        );
        expect(loadTaskDraft('task-1')).toEqual({
            text: 't',
            images: [{ dataUrl: 'data:x', name: 'n' }],
            filePaths: []
        });
    });

    test('filePaths 字段过滤非字符串与空字符串，且旧数据无该字段视为空数组', () => {
        const fake = installStorage(new FakeStorage());
        // 旧版本持久化数据（无 filePaths）向后兼容
        fake.setItem('opendesk:task-draft:legacy', JSON.stringify({ text: 'old', images: [] }));
        expect(loadTaskDraft('legacy')).toEqual({ text: 'old', images: [], filePaths: [] });
        // 新数据中混入非法项时过滤
        fake.setItem(
            'opendesk:task-draft:task-1',
            JSON.stringify({ text: 't', images: [], filePaths: ['D:/ok.txt', '', 42, null, '  '] })
        );
        expect(loadTaskDraft('task-1')?.filePaths).toEqual(['D:/ok.txt']);
    });

    test('localStorage 不可用时全部操作安全 no-op', () => {
        Object.defineProperty(globalThis, 'localStorage', { value: undefined, writable: true, configurable: true });
        expect(() => saveTaskDraft('task-1', { text: 'x', images: [], filePaths: [] })).not.toThrow();
        expect(loadTaskDraft('task-1')).toBeNull();
        expect(() => clearTaskDraft('task-1')).not.toThrow();
    });

    test('taskId 为空时安全 no-op', () => {
        installStorage(new FakeStorage());
        expect(() => saveTaskDraft('', { text: 'x', images: [], filePaths: [] })).not.toThrow();
        expect(loadTaskDraft('')).toBeNull();
        expect(() => clearTaskDraft('')).not.toThrow();
    });
});
