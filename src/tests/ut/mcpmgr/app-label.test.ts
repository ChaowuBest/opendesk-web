import { McpMgrApplication } from '../../../main/applications/mcpmgr/app.js';
import { t as mcpT } from '../../../main/applications/mcpmgr/locale/index.js';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../main/applications/mcpmgr/app.ts', import.meta.url), 'utf8');

describe('MCP management application label', () => {
    test('uses the MCP-localized application name', () => {
        const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;

        expect(app.getName()).toBe(mcpT('app.name'));
        expect(app.getName()).not.toBe('OpenDesk');
    });

    test('keeps the global translator from shadowing the MCP translator', () => {
        // 主 locale 仅用于读取跨应用共享的平台词条（harmony.localRuntime.*），必须别名导入；
        // 裸名 t 必须来自 mcpmgr 应用自己的 locale。
        expect(appSource).toContain("import { t as platformT } from '../../../locale/index.js'");
        expect(appSource).not.toMatch(/import \{ t \} from '\.\.\/\.\.\/\.\.\/locale\/index\.js'/);
        expect(appSource).toContain("import { t } from './locale/index.js'");
    });
});
