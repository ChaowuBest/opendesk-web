/**
 * 设置保存提示的两个入口：文案映射、未知步骤兜底、通知缺失时不抛错。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    notifySettingSaveFailed,
    notifySettingSideEffectFailures
} from '../../../renderer/utils/setting-side-effect-notice.js';

const sendNotification = jest.fn();

function translate(key: string): string {
    const dictionary: Record<string, string> = {
        'sp.title': '设置',
        'sp.save.failed': '自动保存失败',
        'sp.save.sideEffectFailed': '设置已保存，但部分改动未能立即生效',
        'sp.save.sideEffect.worker-settings-sync': '后台线程未能同步新设置'
    };
    return dictionary[key] ?? key;
}

beforeEach(() => {
    sendNotification.mockReset();
    (globalThis as unknown as { window: unknown }).window = { notificationAPI: { sendNotification } };
});

afterEach(() => {
    (globalThis as unknown as { window?: unknown }).window = undefined;
});

describe('notifySettingSideEffectFailures', () => {
    test('无失败步骤时不发通知', () => {
        notifySettingSideEffectFailures([], translate);
        expect(sendNotification).not.toHaveBeenCalled();
    });

    test('按步骤 id 映射本地化文案，原始异常只进控制台', () => {
        notifySettingSideEffectFailures([{ label: 'worker-settings-sync', message: 'ENOENT boom' }], translate);

        expect(sendNotification).toHaveBeenCalledTimes(1);
        const [level, source, title, message] = sendNotification.mock.calls[0] as string[];
        expect(level).toBe('error');
        expect(source).toBe('设置');
        expect(title).toBe('设置已保存，但部分改动未能立即生效');
        expect(message).toBe('后台线程未能同步新设置');
        // 内部细节不能漏进通知正文
        expect(message).not.toContain('ENOENT');
    });

    test('缺少文案的步骤退回原始信息，而不是把 locale key 露给用户', () => {
        notifySettingSideEffectFailures([{ label: 'telemetry-reload', message: 'reload failed' }], translate);

        const message = (sendNotification.mock.calls[0] as string[])[3];
        expect(message).toBe('reload failed');
        expect(message).not.toContain('sp.save.sideEffect');
    });

    test('通知接口缺席时不抛错（提示失败不能影响保存结果）', () => {
        (globalThis as unknown as { window: unknown }).window = {};

        expect(() =>
            notifySettingSideEffectFailures([{ label: 'theme-apply', message: 'x' }], translate)
        ).not.toThrow();
    });

    test('通知本身抛错时不外泄给调用方', () => {
        sendNotification.mockImplementation(() => {
            throw new Error('notification channel broken');
        });

        expect(() =>
            notifySettingSideEffectFailures([{ label: 'theme-apply', message: 'x' }], translate)
        ).not.toThrow();
    });
});

describe('notifySettingSaveFailed', () => {
    test('用 error 级别上报保存失败与原始原因', () => {
        notifySettingSaveFailed(new Error('EACCES: permission denied'), translate);

        expect(sendNotification).toHaveBeenCalledTimes(1);
        const [level, source, title, message] = sendNotification.mock.calls[0] as string[];
        expect(level).toBe('error');
        expect(source).toBe('设置');
        expect(title).toBe('自动保存失败');
        expect(message).toBe('EACCES: permission denied');
    });

    test('非 Error 的失败原因按字符串上报', () => {
        notifySettingSaveFailed('plain failure', translate);

        expect((sendNotification.mock.calls[0] as string[])[3]).toBe('plain failure');
    });
});
