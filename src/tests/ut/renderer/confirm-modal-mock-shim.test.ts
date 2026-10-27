import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';
import * as realConfirmModal from '../../../renderer/components/confirmModal.js';

/**
 * 钉住 confirmModalMockShim 的契约：mock 掉 confirmModal 之后，导入链仍要能链接成功。
 *
 * browser.ts 从 confirmModal 取 showConfirmModal / showInfoModal / escapeModalText 三个名字，
 * jest 的 ESM 链接期会校验 mock 工厂是否都提供了它们，缺一个就抛
 * "does not provide an export named 'escapeModalText'"。把 shim 里那行删掉，本测试就会以
 * 完全相同的错误失败——这正是各测试 mock confirmModal 时必须带上该导出的原因。
 */
describe('confirmModal mock shim', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            customElements: window.customElements,
            localStorage: { getItem: () => null }
        });
        (window as any).__odT = (key: string) => key;
        (window as any).applicationRegistryAPI = { callMainWorld: jest.fn() };
        jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () =>
            confirmModalMockShim({ showConfirmModal: jest.fn(), showInfoModal: jest.fn() })
        );
    });

    test('用 shim mock confirmModal 后 browser.ts 可正常链接', async () => {
        const mod = await import('../../../renderer/browser.js');
        expect(mod).toBeDefined();
    });

    test('shim 提供的 escapeModalText 会转义 HTML', async () => {
        const mod = await import('../../../renderer/components/confirmModal.js');
        expect((mod as any).escapeModalText('<b>a&b</b>')).toBe('&lt;b&gt;a&amp;b&lt;/b&gt;');
    });

    test('shim 的每个键都是 confirmModal 的真实导出（防止写错名字或提前清理）', () => {
        const shim = confirmModalMockShim();
        const unknownKeys = Object.keys(shim).filter((key) => !(key in realConfirmModal));
        expect(unknownKeys).toEqual([]);
    });

    test('shim 复制的动画时长与真实实现一致', () => {
        const shim = confirmModalMockShim();
        expect(shim.MODAL_ANIM_DURATION_IN).toBe(realConfirmModal.MODAL_ANIM_DURATION_IN);
        expect(shim.MODAL_ANIM_DURATION_OUT).toBe(realConfirmModal.MODAL_ANIM_DURATION_OUT);
    });
});
