import { describe, expect, it } from '@jest/globals';
import { shouldConfirmOnEnter } from '../../../renderer/components/confirmModal.ts';

/**
 * 确认弹窗（showConfirmModal）在调用方显式开启 enterToConfirm 时（目前仅
 * taskview 的"确认编辑消息"弹窗），焦点不在可交互元素上时按回车应默认触发
 * "确认"（回车=继续对话）；焦点在输入框 / 按钮 / 链接等元素上时，回车交给
 * 原生行为，避免误触发。
 */
describe('shouldConfirmOnEnter', () => {
    it('焦点在非交互元素（如 body / 遮罩）上时，回车应触发确认', () => {
        expect(shouldConfirmOnEnter({ tagName: 'BODY' } as HTMLElement, false, false)).toBe(true);
        expect(shouldConfirmOnEnter({ tagName: 'DIV' } as HTMLElement, false, false)).toBe(true);
    });

    it('焦点不在任何元素上时，回车应触发确认', () => {
        expect(shouldConfirmOnEnter(null, false, false)).toBe(true);
    });

    it('challenge 未匹配（确认按钮禁用）时，回车不应触发确认', () => {
        expect(shouldConfirmOnEnter({ tagName: 'BODY' } as HTMLElement, true, true)).toBe(false);
    });

    it('challenge 已匹配（确认按钮可用）时，回车应触发确认', () => {
        expect(shouldConfirmOnEnter({ tagName: 'BODY' } as HTMLElement, true, false)).toBe(true);
    });

    it('焦点在输入框（如 challenge 输入框）上时，回车不触发确认，交给原生/输入框自身处理', () => {
        expect(shouldConfirmOnEnter({ tagName: 'INPUT' } as HTMLElement, false, false)).toBe(false);
        expect(shouldConfirmOnEnter({ tagName: 'TEXTAREA' } as HTMLElement, false, false)).toBe(false);
        expect(shouldConfirmOnEnter({ tagName: 'SELECT' } as HTMLElement, false, false)).toBe(false);
    });

    it('焦点在按钮 / 链接上时，回车不触发确认，交给原生激活行为', () => {
        expect(shouldConfirmOnEnter({ tagName: 'BUTTON' } as HTMLElement, false, false)).toBe(false);
        expect(shouldConfirmOnEnter({ tagName: 'A' } as HTMLElement, false, false)).toBe(false);
    });

    it('焦点在可编辑富文本元素上时，回车不触发确认', () => {
        expect(shouldConfirmOnEnter({ tagName: 'DIV', isContentEditable: true } as HTMLElement, false, false)).toBe(
            false
        );
    });
});
