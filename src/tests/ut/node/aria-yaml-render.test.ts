/**
 * 集成测试：验证 renderAriaTreeToYaml 正确处理包含数字 "0" 的 ARIA name
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { renderAriaTreeToYaml } from '../../../common/embedBrowserUse/cdp/aria.js';

describe('renderAriaTreeToYaml — 数字 0 保留测试', () => {
    it('cell name 包含 "0天3小时" 不应丢失 0', () => {
        const root = {
            role: 'fragment' as const,
            name: '',
            children: [
                {
                    role: 'cell' as const,
                    name: '0天3小时',
                    children: [],
                    props: {},
                    ref: 'e4'
                }
            ],
            props: {}
        };

        const yaml = renderAriaTreeToYaml(root);
        assert.ok(yaml.includes('0天3小时'), `YAML 应包含 "0天3小时"，实际: ${yaml}`);
        assert.ok(!yaml.includes(' 天3小时'), `YAML 不应包含损坏的 " 天3小时"，实际: ${yaml}`);
    });

    it('cell name 包含 "正常文本: 0天3小时" 不应丢失 0', () => {
        const root = {
            role: 'fragment' as const,
            name: '',
            children: [
                {
                    role: 'cell' as const,
                    name: '正常文本: 0天3小时',
                    children: [],
                    props: {},
                    ref: 'e4'
                }
            ],
            props: {}
        };

        const yaml = renderAriaTreeToYaml(root);
        assert.ok(yaml.includes('正常文本: 0天3小时'), `YAML 应包含完整文本，实际: ${yaml}`);
    });

    it('cell name 为纯文本 "0" 应正确渲染', () => {
        const root = {
            role: 'fragment' as const,
            name: '',
            children: [
                {
                    role: 'cell' as const,
                    name: '0',
                    children: [],
                    props: {},
                    ref: 'e1'
                }
            ],
            props: {}
        };

        const yaml = renderAriaTreeToYaml(root);
        assert.ok(yaml.includes('"0"'), `YAML 应包含 "0"，实际: ${yaml}`);
    });
});
