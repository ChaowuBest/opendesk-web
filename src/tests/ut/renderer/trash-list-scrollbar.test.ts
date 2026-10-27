import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import { ruleBody } from './cssRules.js';

/**
 * 文件回收站弹窗列表（.trash-list-scroll）滚动条必须自定义：
 * 未定义 ::-webkit-scrollbar 时回退系统原生样式，深色模式下出现
 * 白色背景/白色轨道的粗滚动条，与 TaskView 聊天历史的一级滚动条
 * 规格不一致（6px、透明轨道、浅色半透明黑 thumb / 深色半透明白 thumb）。
 * 组件内联样式随 MODAL_CSS 注入，深色由 overlay 上的 .od-modal-dark class 控制。
 */

const source = fs.readFileSync(new URL('../../../renderer/components/trashFloatingWindow.ts', import.meta.url), 'utf8');

describe('文件回收站列表滚动条样式', () => {
    it('滚动容器必须自定义 webkit 滚动条且横向与纵向同粗', () => {
        const body = ruleBody(source, '.trash-list-scroll::-webkit-scrollbar');
        expect(body).toMatch(/width:\s*6px/);
        expect(body).toMatch(/height:\s*6px/);
    });

    it('轨道必须透明，不允许出现白色/深色实底轨道', () => {
        const body = ruleBody(source, '.trash-list-scroll::-webkit-scrollbar-track');
        expect(body).toMatch(/background:\s*transparent/);
    });

    it('浅色模式使用半透明黑 thumb（对齐 TaskView 规格）', () => {
        const body = ruleBody(source, '.trash-list-scroll::-webkit-scrollbar-thumb');
        expect(body).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.14\)/);
        expect(body).toMatch(/border-radius:\s*3px/);
        const hover = ruleBody(source, '.trash-list-scroll::-webkit-scrollbar-thumb:hover');
        expect(hover).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.24\)/);
    });

    it('深色模式（od-modal-dark）必须覆盖为半透明白 thumb', () => {
        const body = ruleBody(source, '.od-modal-dark .trash-list-scroll::-webkit-scrollbar-thumb');
        expect(body).toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.18\)/);
        const hover = ruleBody(source, '.od-modal-dark .trash-list-scroll::-webkit-scrollbar-thumb:hover');
        expect(hover).toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.28\)/);
    });
});
