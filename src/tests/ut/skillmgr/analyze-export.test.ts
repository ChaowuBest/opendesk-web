import { generateAnalyzeExportPage } from '../../../main/applications/skillmgr/analyzer/analyze-export.js';
import { CHEVRON_DOWN_SVG, CHEVRON_RIGHT_SVG, CHEVRON_UP_SVG } from '../../../common/ui-icons.js';

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
