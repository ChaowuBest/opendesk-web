import { generateAnalyzeExportPage } from '../../../main/applications/skillmgr/analyzer/analyze-export.js';
import { CHEVRON_DOWN_SVG, CHEVRON_RIGHT_SVG, CHEVRON_UP_SVG } from '../../../common/ui-icons.js';
import { parseHTML } from 'linkedom';
import { createContext, runInContext } from 'node:vm';

// Unicode 几何箭头（▶ ▸ ▾ 等）跨平台字体渲染差异大，部分环境会被渲染为彩色 emoji，
// GUI 图标统一使用内联 SVG chevron，页面中不允许再出现此类字符
const UNICODE_GEOMETRIC_ARROWS = /[▶▸▾▿▲△◀◁]/;

describe('generateAnalyzeExportPage', () => {
    const page = generateAnalyzeExportPage();

    test('does not contain unicode geometric arrows', () => {
        expect(page).not.toMatch(UNICODE_GEOMETRIC_ARROWS);
    });

    test('renders accordion arrows as inline svg', () => {
        expect(page).toContain('<span class="accordion-arrow"><svg ');
    });

    test('runs offline with embedded data and renders markdown without external scripts', () => {
        const html = generateAnalyzeExportPage([
            {
                skill: { id: 'demo', name: 'Offline skill', description: 'Demo', body: '**Offline body**' },
                meta: {
                    testCases: [
                        {
                            index: 1,
                            title: 'Example',
                            prompt: '**Prompt**',
                            expectedResult: '*Result*',
                            status: 'passed'
                        }
                    ]
                }
            }
        ]);
        const { document } = parseHTML(html);
        const context = createContext({ document });
        expect(document.querySelector('script[src]')).toBeNull();
        for (const script of document.querySelectorAll('script')) runInContext(script.textContent, context);

        expect(document.querySelector('#analyzeList').textContent).toContain('Offline skill');
        runInContext('showSkillDetailModal("demo")', context);
        expect(document.querySelector('#detailBody strong').textContent).toBe('Offline body');
        runInContext('showTestCasesModal("demo")', context);
        expect(document.querySelector('#modalBody strong').textContent).toBe('Prompt');
        expect(document.querySelector('#modalBody em').textContent).toBe('Result');
    });

    test('embedded report data cannot close its script and private report paths stay omitted', () => {
        const name = '</script><script>globalThis.injected=true</script>';
        const html = generateAnalyzeExportPage([
            {
                skill: { id: 'unsafe', name, description: '', body: '<script>globalThis.injected=true</script>' },
                analysisReport: { skill: { path: '/private/skill/path' }, checkpoints: [] }
            }
        ]);
        const { document } = parseHTML(html);
        const context = createContext({ document });
        expect(document.querySelectorAll('script')).toHaveLength(2);
        expect(html).not.toContain('/private/skill/path');
        for (const script of document.querySelectorAll('script')) runInContext(script.textContent, context);
        runInContext('showSkillDetailModal("unsafe")', context);

        expect(context.injected).toBeUndefined();
        expect(document.querySelector('#detailName').textContent).toBe(name);
        expect(document.querySelector('#detailBody script')).toBeNull();
        expect(document.querySelector('#detailBody').textContent).toContain('<script>');
    });
});

describe('chevron icon constants', () => {
    test.each([CHEVRON_RIGHT_SVG, CHEVRON_DOWN_SVG, CHEVRON_UP_SVG])(
        'self-contained svg sized by font-size and colored by currentColor',
        (svg) => {
            expect(svg).toMatch(/^<svg /);
            expect(svg).toContain('viewBox="0 0 24 24"');
            expect(svg).toContain('stroke="currentColor"');
            expect(svg).toContain('width:1em;height:1em');
            expect(svg).not.toContain('class=');
        }
    );

    test('right/down/up chevrons use distinct paths', () => {
        expect(CHEVRON_RIGHT_SVG).toContain('M9 6l6 6-6 6');
        expect(CHEVRON_DOWN_SVG).toContain('M6 9l6 6 6-6');
        expect(CHEVRON_UP_SVG).toContain('M6 15l6-6 6 6');
    });
});
