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

import { describe, expect, it, jest } from '@jest/globals';
import { parseGenUiProps } from '../../../common/genui/catalog.js';
import { SAMPLE_PROPS } from './fixtures.js';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcMainMock = {
    handle: jest.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        if (handlers.has(channel)) throw new Error(`duplicate handler ${channel}`);
        handlers.set(channel, handler);
    })
};

jest.unstable_mockModule('../../../utils/electron.js', () => ({
    electron: () => ({
        BrowserWindow: { getAllWindows: () => [] },
        ipcMain: ipcMainMock,
        Notification: { isSupported: () => false }
    })
}));

const { ElectronGenUiProvider, hasPendingGenUiRequest, respondToGenUiRequest } =
    await import('../../../main/aikernel/interaction/electronGenUi.js');

const parsed = parseGenUiProps('option-list', SAMPLE_PROPS['option-list']);
const optionProps = parsed.success ? parsed.props : {};

function request(requestId: string) {
    return { requestId, taskId: 'task-1', component: 'option-list' as const, props: optionProps };
}

describe('ElectronGenUiProvider', () => {
    it('registers the respond handler once for all providers', () => {
        new ElectronGenUiProvider();
        new ElectronGenUiProvider();
        expect(ipcMainMock.handle).toHaveBeenCalledTimes(1);
        expect(handlers.has('genui:respond')).toBe(true);
    });

    it('resolves the matching request with a validated response', async () => {
        const provider = new ElectronGenUiProvider();
        const pending = provider.request(request('genui-a'));
        expect(hasPendingGenUiRequest('genui-a')).toBe(true);

        const handler = handlers.get('genui:respond')!;
        expect(handler({}, 'genui-a', { selected: ['nope'] })).toMatchObject({ ok: false, error: 'invalid' });
        // 非法回传不结算，用户还能重新提交
        expect(hasPendingGenUiRequest('genui-a')).toBe(true);

        expect(handler({}, 'genui-a', { selected: ['prod'] })).toEqual({ ok: true });
        await expect(pending).resolves.toEqual({ response: { selected: ['prod'] } });
        expect(hasPendingGenUiRequest('genui-a')).toBe(false);
        expect(handler({}, 'genui-a', { selected: ['prod'] })).toEqual({ ok: false, error: 'expired' });
    });

    it('rejects malformed request ids', () => {
        expect(respondToGenUiRequest(42, {})).toMatchObject({ ok: false, error: 'invalid' });
        expect(respondToGenUiRequest('genui-missing', {})).toEqual({ ok: false, error: 'expired' });
    });

    it('cancels only the requests of its own task', async () => {
        const first = new ElectronGenUiProvider();
        const second = new ElectronGenUiProvider();
        const firstPending = first.request(request('genui-b'));
        second.request(request('genui-c'));

        first.cancelCurrent();
        await expect(firstPending).resolves.toEqual({ cancelled: true });
        expect(hasPendingGenUiRequest('genui-b')).toBe(false);
        expect(hasPendingGenUiRequest('genui-c')).toBe(true);
        second.cancelCurrent();
        expect(hasPendingGenUiRequest('genui-c')).toBe(false);
    });

    it('cancels a request nobody answers', async () => {
        jest.useFakeTimers();
        try {
            const pending = new ElectronGenUiProvider().request(request('genui-d'));
            jest.advanceTimersByTime(30 * 60_000);
            await expect(pending).resolves.toEqual({ cancelled: true });
        } finally {
            jest.useRealTimers();
        }
    });
});
