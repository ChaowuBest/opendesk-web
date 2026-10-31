/**
 * Setting.setData 持久化事务测试：
 * 落盘成功之前不得提交内存配置、不得触发变更回调；
 * 落盘失败时内存、磁盘与回调观察到的状态必须保持一致。
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { Setting, getOpendeskDirectory } from '../../../main/utils/setting.js';

function settingFilePath(): string {
    return path.join(getOpendeskDirectory(), 'setting.json');
}

function readDiskSetting(): Record<string, any> {
    return JSON.parse(fs.readFileSync(settingFilePath(), 'utf8'));
}

function temporarySettingFiles(): string[] {
    return fs
        .readdirSync(getOpendeskDirectory())
        .filter((name) => name.startsWith('setting.json.') && name.endsWith('.tmp'));
}

function ioError(code: string): NodeJS.ErrnoException {
    const error = new Error(`${code}: i/o error`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

describe('Setting.setData 持久化事务', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        Setting.afterSetDataCallbacks = [];
        Setting.applicationConfigChangedCallbacks.clear();
    });

    test('写盘失败时内存配置、磁盘配置与变更回调都保持旧值', () => {
        const setting = new Setting();
        setting.save();
        expect(setting.getData().debug.developer_mode).toBe(false);
        expect(readDiskSetting().debug.developer_mode).toBe(false);

        let callbacks = 0;
        Setting.afterSetDataCallbacks.push(() => {
            callbacks += 1;
        });

        jest.spyOn(fs, 'writeFileSync').mockImplementation((() => {
            throw ioError('EIO');
        }) as any);

        const current = setting.getData();
        expect(() => setting.setData({ ...current, debug: { ...current.debug, developer_mode: true } })).toThrow(/EIO/);

        // 内存未提交候选值
        expect(setting.getData().debug.developer_mode).toBe(false);
        // 磁盘仍是旧值
        expect(readDiskSetting().debug.developer_mode).toBe(false);
        // 变更回调未执行
        expect(callbacks).toBe(0);
    });

    test('rename 失败时旧 setting.json 保持完整且不残留临时文件', () => {
        const setting = new Setting();
        setting.save();
        const diskBefore = fs.readFileSync(settingFilePath(), 'utf8');

        jest.spyOn(fs, 'renameSync').mockImplementation((() => {
            throw ioError('EXDEV');
        }) as any);

        const current = setting.getData();
        expect(() => setting.setData({ ...current, debug: { ...current.debug, developer_mode: true } })).toThrow(
            /EXDEV/
        );

        expect(fs.readFileSync(settingFilePath(), 'utf8')).toBe(diskBefore);
        expect(setting.getData().debug.developer_mode).toBe(false);
        expect(temporarySettingFiles()).toEqual([]);
    });

    test('写盘成功后才提交内存并触发变更回调', () => {
        const setting = new Setting();
        setting.save();

        const observed: Array<{ previous: boolean; next: boolean }> = [];
        Setting.afterSetDataCallbacks.push((previousData, nextData) => {
            // 回调执行时内存必须已经是新配置
            expect(setting.getData()).toBe(nextData);
            observed.push({
                previous: previousData.debug.developer_mode,
                next: nextData.debug.developer_mode
            });
        });

        const current = setting.getData();
        setting.setData({ ...current, debug: { ...current.debug, developer_mode: true } });

        expect(setting.getData().debug.developer_mode).toBe(true);
        expect(readDiskSetting().debug.developer_mode).toBe(true);
        expect(temporarySettingFiles()).toEqual([]);
        expect(observed).toEqual([{ previous: false, next: true }]);
    });

    test('原始 LLM 响应日志开关只保留在内存，不会写入磁盘或在加载后恢复', () => {
        const setting = new Setting();
        setting.save();

        setting.setData({ ...setting.getData(), debug: { ...setting.getData().debug, log_raw_llm_request: true } });

        expect(setting.getData().debug.log_raw_llm_request).toBe(true);
        expect(readDiskSetting().debug.log_raw_llm_request).toBe(false);

        setting.updateAndSave((draft) => {
            draft.debug.debug_log = true;
        });
        expect(setting.getData().debug.log_raw_llm_request).toBe(true);
        expect(readDiskSetting().debug.log_raw_llm_request).toBe(false);

        // Worker 的设置同步继续接收当前运行状态；只有从磁盘重启才恢复关闭。
        Setting.updateInstanceData(setting.getData());
        expect(Setting.getInstance().getData().debug.log_raw_llm_request).toBe(true);
        const loaded = Setting.load();
        expect(loaded?.getData().debug.log_raw_llm_request).toBe(false);
    });

    test('旧配置中遗留的 raw logging=true 在加载时被忽略且不要求重写文件', () => {
        const legacy = new Setting().getData();
        legacy.debug.log_raw_llm_request = true;
        legacy.debug.developer_mode = true;
        fs.writeFileSync(settingFilePath(), JSON.stringify(legacy));
        const writeSpy = jest.spyOn(fs, 'writeFileSync');

        const loaded = Setting.load();

        expect(loaded?.getData().debug.log_raw_llm_request).toBe(false);
        expect(loaded?.getData().debug.developer_mode).toBe(true);
        expect(writeSpy).not.toHaveBeenCalled();
    });

    test('默认模型失效引用的清理结果仍然会落盘', () => {
        const setting = new Setting();
        setting.save();

        const current = setting.getData();
        setting.setData({ ...current, default_model: 'model-not-exist' });

        expect(setting.getData().default_model).toBe('');
        expect(readDiskSetting().default_model).toBe('');
    });

    // Windows 不暴露 POSIX 权限位，仅在类 Unix 平台校验
    const permissionTest = process.platform === 'win32' ? test.skip : test;
    permissionTest('原子替换保留 setting.json 原有权限位', () => {
        const setting = new Setting();
        setting.save();
        // setting.json 含模型 API Key，替换后不应被放宽成默认权限
        fs.chmodSync(settingFilePath(), 0o600);

        const current = setting.getData();
        setting.setData({ ...current, debug: { ...current.debug, developer_mode: true } });

        expect(fs.statSync(settingFilePath()).mode & 0o777).toBe(0o600);
    });

    permissionTest('首次创建 setting.json 时同样使用 0600 权限', () => {
        // 用户删掉配置后重启：此时没有可沿用的旧权限，不能依赖 umask 的默认放宽
        fs.rmSync(settingFilePath(), { force: true });
        const setting = new Setting();
        setting.save();

        expect(fs.statSync(settingFilePath()).mode & 0o777).toBe(0o600);
    });

    test('load 清理崩溃遗留的临时文件，但保留近期写入的临时文件', () => {
        const setting = new Setting();
        setting.save();
        const directory = getOpendeskDirectory();
        const staleFile = path.join(directory, 'setting.json.999990.1.tmp');
        const freshFile = path.join(directory, 'setting.json.999990.2.tmp');
        try {
            fs.writeFileSync(staleFile, '{}');
            fs.writeFileSync(freshFile, '{}');
            // 两小时前：保存本身是毫秒级，这个时间点上的临时文件必然是崩溃遗留
            const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
            fs.utimesSync(staleFile, twoHoursAgo, twoHoursAgo);

            expect(Setting.load()).not.toBeNull();

            expect(fs.existsSync(staleFile)).toBe(false);
            // 并发进程（如同时运行的 CLI）可能正在写自己的临时文件，不能按后缀一律删除
            expect(fs.existsSync(freshFile)).toBe(true);
        } finally {
            // 断言失败时也要清理，否则残留文件会污染后续用例的临时文件断言
            fs.rmSync(staleFile, { force: true });
            fs.rmSync(freshFile, { force: true });
        }
    });
});

describe('Setting.updateAndSave 事务式写入', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        Setting.afterSetDataCallbacks = [];
        Setting.applicationConfigChangedCallbacks.clear();
    });

    test('写盘失败时内存配置与磁盘配置都保持旧值', () => {
        const setting = new Setting();
        setting.save();

        jest.spyOn(fs, 'writeFileSync').mockImplementation((() => {
            throw ioError('EIO');
        }) as any);

        expect(() =>
            setting.updateAndSave((draft) => {
                draft.debug.developer_mode = true;
            })
        ).toThrow(/EIO/);

        expect(setting.getData().debug.developer_mode).toBe(false);
        expect(readDiskSetting().debug.developer_mode).toBe(false);
        expect(temporarySettingFiles()).toEqual([]);
    });

    test('mutator 抛错时不落盘，也不污染当前内存配置', () => {
        const setting = new Setting();
        setting.save();
        const memoryBefore = setting.getData();
        const diskBefore = fs.readFileSync(settingFilePath(), 'utf8');

        expect(() =>
            setting.updateAndSave((draft) => {
                draft.debug.developer_mode = true;
                throw new Error('mutator boom');
            })
        ).toThrow(/mutator boom/);

        // mutator 改的是副本：中途抛错不会让内存配置变成「改了一半」的状态
        expect(setting.getData()).toBe(memoryBefore);
        expect(setting.getData().debug.developer_mode).toBe(false);
        expect(fs.readFileSync(settingFilePath(), 'utf8')).toBe(diskBefore);
    });

    test('写盘成功后提交内存并通知全局订阅者，但不触发应用级变更回调', () => {
        const setting = new Setting();
        setting.save();

        const globalNotifications: Array<{ previous: boolean; next: boolean }> = [];
        Setting.afterSetDataCallbacks.push((previousData, nextData) => {
            globalNotifications.push({
                previous: previousData.debug.developer_mode,
                next: nextData.debug.developer_mode
            });
        });
        let applicationCallbacks = 0;
        Setting.applicationConfigChangedCallbacks.set('demo-app', () => {
            applicationCallbacks += 1;
        });

        setting.updateAndSave((draft) => {
            draft.debug.developer_mode = true;
        });

        expect(setting.getData().debug.developer_mode).toBe(true);
        expect(readDiskSetting().debug.developer_mode).toBe(true);
        // 全局订阅者（renderer 广播、Worker 网络配置同步、浮窗刷新）必须收到通知，
        // 否则配置已落盘、界面和 Worker 却还在用旧值
        expect(globalNotifications).toEqual([{ previous: false, next: true }]);
        // 应用级回调需要新旧配置逐项对比，updateAndSave 不做这件事，仍只由 setData 触发
        expect(applicationCallbacks).toBe(0);
    });

    test('mutator 收到的是配置副本，不是当前内存对象', () => {
        const setting = new Setting();
        setting.save();
        const memoryBefore = setting.getData();
        let received: unknown;

        setting.updateAndSave((draft) => {
            received = draft;
        });

        // 副本来自旧配置的快照：提交后内存配置被整体替换成副本
        expect(received).not.toBe(memoryBefore);
        expect(memoryBefore.debug.developer_mode).toBe(false);
        expect(received).toEqual(setting.getData());
    });

    test('mutator 写入不合 schema 的数据时拒绝落盘', () => {
        const setting = new Setting();
        setting.save();
        const diskBefore = fs.readFileSync(settingFilePath(), 'utf8');

        expect(() =>
            setting.updateAndSave((draft) => {
                // locale 是枚举：越界值会让下次启动 load() 的 schema 解析失败，
                // 进而回落到默认配置、丢掉用户整份设置
                (draft as unknown as Record<string, unknown>).locale = 'not-a-locale';
            })
        ).toThrow();

        expect(fs.readFileSync(settingFilePath(), 'utf8')).toBe(diskBefore);
        expect(setting.getData().locale).toBe('auto');
    });
});
