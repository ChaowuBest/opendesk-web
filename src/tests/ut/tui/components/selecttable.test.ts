import { SelectTable, type SelectRow } from '../../../../main/tui/components/selecttable';
import { defaultSelectListTheme } from '../../../../main/tui/theme';
import { visibleWidth } from '@earendil-works/pi-tui';

function createTable(rows: SelectRow[], factors: number[]): SelectTable {
    const table = new SelectTable(rows, rows.length, defaultSelectListTheme);
    table.setColumnStrechFactors(factors);
    return table;
}

describe('SelectTable 列宽分配', () => {
    test('单行内容超长时内容列不应整列消失，而是按可用宽度截断', () => {
        const longText = 'x'.repeat(300);
        const table = createTable(
            [
                { labels: ['1', 'short', '10-22 14:00'], value: 'a' },
                { labels: ['2', longText, '10-22 15:00'], value: 'b' }
            ],
            [0, 4, 1]
        );
        table.setAlignments(['right', 'left', 'right']);

        table.render(150);

        const labels = table.innerRows.map((row) => row.label);
        // 短内容行必须仍然能看到内容列
        expect(labels[0]).toContain('short');
        // 超长内容行必须被截断，而不是整列消失
        expect(labels[1]).toContain('…');
        expect(labels[1].length).toBeGreaterThan('2  '.length + 10);
        // 时间列也必须保留
        expect(labels[0]).toContain('10-22 14:00');
        expect(labels[1]).toContain('10-22 15:00');
    });

    test('渲染总宽度不超过可用宽度', () => {
        const table = createTable(
            [
                { labels: ['1', 'a'.repeat(200), '10-22 14:00'], value: 'a' },
                { labels: ['2', 'short', '10-22 15:00'], value: 'b' }
            ],
            [0, 4, 1]
        );

        table.render(150);

        for (const row of table.innerRows) {
            expect(visibleWidth(row.label)).toBeLessThanOrEqual(150 - 5);
        }
    });

    test('终端极窄时逐列隐藏右侧列，至少保留第一列', () => {
        const table = createTable(
            [
                { labels: ['1', 'some preview text', '10-22 14:00'], value: 'a' },
                { labels: ['2', 'another preview', '10-22 15:00'], value: 'b' }
            ],
            [0, 4, 1]
        );

        table.render(4);

        const labels = table.innerRows.map((row) => row.label);
        expect(labels[0].trim()).toBe('1');
        expect(labels[1].trim()).toBe('2');
    });

    test('终端偏窄时隐藏尾部时间列，内容列按可用宽度截断', () => {
        const table = createTable([{ labels: ['1', 'preview', '10-22 14:00'], value: 'a' }], [0, 4, 1]);

        table.render(12);

        const label = table.innerRows[0].label;
        expect(label).toContain('1');
        expect(label).toContain('…');
        expect(label).not.toContain('14:00');
        expect(visibleWidth(label)).toBeLessThanOrEqual(12 - 5);
    });

    test('宽度变化后重新计算列宽', () => {
        const table = createTable([{ labels: ['1', 'preview', '10-22 14:00'], value: 'a' }], [0, 4, 1]);

        table.render(150);
        expect(table.innerRows[0].label).toContain('10-22 14:00');

        table.render(4);
        expect(table.innerRows[0].label.trim()).toBe('1');
    });
});
