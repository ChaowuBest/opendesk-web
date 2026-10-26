import { escapeHtml } from '../common/utils/escape.js';

/**
 * confirmModal 的 mock 工厂骨架，供所有 `jest.unstable_mockModule('.../confirmModal')`
 * 的测试复用。
 *
 * jest 在 ESM 链接期会校验 mock 工厂是否提供了被测链路上**所有**真实导入名，缺一个
 * 就报 `does not provide an export named ...`。confirmModal 除了两个弹窗函数，还被
 * browser.ts / browser entry 当作转义入口使用（escapeModalText），所以任何 mock 它
 * 的测试都必须带上这一项，哪怕该测试根本不弹确认框。
 *
 * 转义复用共享的 escapeHtml，而不是在各测试里各写一份 replace 链：断言要验证的是
 * 调用点有没有走转义，不是重复实现转义规则。confirmModal 新增对外导出时只改这里。
 *
 * 本 shim 只兜住转义入口；弹窗函数仍由各测试自己传入（它们要拿 jest.fn 做断言），
 * 例如 `confirmModalMockShim({ showConfirmModal: jest.fn() })`。
 */
export function confirmModalMockShim(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        escapeModalText: (text: string) => escapeHtml(text),
        ...extra
    };
}
