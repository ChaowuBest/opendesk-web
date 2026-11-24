import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { setRuntimeLocale } from '../../../../locale/index.js';
import { extractText } from '../../../../main/applications/filemgr/parser/extract.js';
import { parseAndChunk } from '../../../../main/applications/filemgr/parser/index.js';

const directories: string[] = [];

function writeWorkbook(
    cells: Record<string, Record<string, unknown>>,
    ref = 'A1:A1',
    options: { date1904?: boolean; extension?: 'xls' | 'xlsx' } = {}
): string {
    const sheet = { ...cells, '!ref': ref } as XLSX.WorkSheet;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    workbook.Workbook = { WBProps: { date1904: options.date1904 ?? false } };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-xlsx-locale-'));
    directories.push(directory);
    const filePath = path.join(directory, `sample.${options.extension ?? 'xlsx'}`);
    XLSX.writeFile(workbook, filePath, { cellNF: true });
    return filePath;
}

test.after(() => {
    setRuntimeLocale(null);
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

test('XLSX numeric display follows the explicit extraction locale', async () => {
    const filePath = writeWorkbook({ A1: { t: 'n', v: 5109095.59, z: '#,##0.00' } });

    assert.match(await extractText(filePath, { locale: 'tr-TR' }), /5\.109\.095,59/);

    assert.match(await extractText(filePath, { locale: 'en-US' }), /5,109,095\.59/);
});

test('parser and indexing retain SheetJS output when no extraction locale is provided', async () => {
    const filePath = writeWorkbook({ A1: { t: 'n', v: 1234.5, z: '#,##0.00' }, B1: { t: 'n', f: '2*3' } }, 'A1:B1');
    const expected = '1\t1,234.50\t';

    for (const locale of ['tr-TR', 'en-US']) {
        setRuntimeLocale(locale);
        assert.equal(await extractText(filePath), expected);
        assert.deepEqual(await parseAndChunk(filePath, { isChunk: false }), { filePath, text: expected });
    }
    assert.equal(await extractText(filePath, { locale: 'tr-TR' }), '1\t1.234,50\t=2*3');
    assert.equal(await extractText(filePath), expected);
});

test('text cells keep the source text instead of parsing locale separators', async () => {
    const filePath = writeWorkbook({ A1: { t: 's', v: '5.109.095,59' } });

    assert.match(await extractText(filePath, { locale: 'en-US' }), /5\.109\.095,59/);
});

test('script locales retain their separators and month names without changing other locales', async () => {
    const filePath = writeWorkbook(
        {
            A1: { t: 'n', v: 1234.5, z: '#,##0.00' },
            B1: { t: 'n', v: 46320, z: 'dddd d mmmm yyyy' }
        },
        'A1:B1'
    );

    for (const [locale, weekday, month] of [
        ['sr-Cyrl-RS', 'недеља', 'октобар'],
        ['sr-Latn-RS', 'nedelja', 'oktobar'],
        ['sr-Cyrl-RS', 'недеља', 'октобар']
    ]) {
        assert.equal(await extractText(filePath, { locale }), `1\t1.234,50\t${weekday} 25 ${month} 2026`);
    }
    assert.equal(await extractText(filePath, { locale: 'en-US' }), '1\t1,234.50\tSunday 25 October 2026');
});

test('locale extensions keep numeric separators and explicit Excel locales still take precedence', async () => {
    const filePath = writeWorkbook(
        {
            A1: { t: 'n', v: 1234.5, z: '#,##0.00' },
            B1: { t: 'n', v: 46320, z: '[$-041F]d mmmm yyyy' }
        },
        'A1:B1'
    );

    assert.equal(await extractText(filePath, { locale: 'tr-TR-u-nu-latn' }), '1\t1.234,50\t25 Ekim 2026');
});

test('explicit Excel date locale takes precedence for localized month names', async () => {
    const filePath = writeWorkbook({ A1: { t: 'n', v: 46320, z: '[$-tr-TR]d MMMM yyyy' } });

    assert.match(await extractText(filePath, { locale: 'en-US' }), /25 Ekim 2026/);
});

test('formula cells without a cached result expose the formula', async () => {
    const filePath = writeWorkbook(
        {
            A1: { t: 'n', v: 2 },
            B1: { t: 'n', v: 3 },
            C1: { t: 'n', f: 'A1*B1' }
        },
        'A1:C1'
    );

    assert.match(await extractText(filePath, { locale: 'en-US' }), /=A1\*B1/);
});

test('Excel formats keep their precision, sections and literals', async (t) => {
    const cases: Array<[string, number, string, string]> = [
        ['General', 1234.5, 'General', '1234,5'],
        ['integer padding and rounding', 12.6, '00000', '00013'],
        ['scientific notation', 123456, '0.00E+00', '1,23E+05'],
        ['conditional section', 12.34, '[>=100]0.0;0.00', '12,34'],
        ['zero in two sections', 0, '0.00;[Red](0.00)', '0,00'],
        ['negative accounting value', -1234.5, '#,##0.00;(#,##0.00)', '(1.234,50)'],
        ['literal percent', 12.5, '0.00"%"', '12,50%'],
        ['leading percent', 0.125, '%0.00', '%12,50'],
        ['literal digits and semicolon', 12.5, '0.00";v2"', '12,50;v2'],
        ['fraction', 1.25, '# ?/?', '1 1/4']
    ];
    for (const [name, value, format, expected] of cases) {
        await t.test(name, async () => {
            const filePath = writeWorkbook({ A1: { t: 'n', v: value, z: format } });
            assert.equal(await extractText(filePath, { locale: 'tr-TR' }), `1\t${expected}`);
        });
    }
});

test('date, time and elapsed time retain the Excel values in different timezones', async () => {
    const filePath = writeWorkbook(
        {
            A1: { t: 'n', v: 46320.5, z: 'yyyy-mm-dd hh:mm' },
            B1: { t: 'n', v: 0.5, z: 'h:mm' },
            C1: { t: 'n', v: 1.5, z: '[h]:mm:ss' },
            D1: { t: 'n', v: 46320, z: 'dd/mm/yyyy' }
        },
        'A1:D1'
    );
    const previousTimezone = process.env.TZ;
    try {
        for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
            process.env.TZ = timezone;
            assert.equal(
                await extractText(filePath, { locale: 'en-US' }),
                '1\t2026-10-25 12:00\t12:00\t36:00:00\t25/10/2026'
            );
        }
    } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
    }
});

test('Excel numeric locale codes take precedence over the active locale', async () => {
    const filePath = writeWorkbook({ A1: { t: 'n', v: 46320, z: '[$-041F]d mmmm yyyy' } });
    assert.equal(await extractText(filePath, { locale: 'en-US' }), '1\t25 Ekim 2026');
});

test('1904 workbooks keep calendar dates and durations while numbers follow the locale', async (t) => {
    for (const extension of ['xls', 'xlsx'] as const) {
        await t.test(extension, async () => {
            const filePath = writeWorkbook(
                {
                    A1: { t: 'n', v: 0, z: 'yyyy-mm-dd' },
                    B1: { t: 'n', v: 1.5, z: 'yyyy-mm-dd hh:mm' },
                    C1: { t: 'n', v: 0.5, z: 'h:mm' },
                    D1: { t: 'n', v: 1.5, z: '[h]:mm:ss' },
                    E1: { t: 'n', v: 1234.5, z: '#,##0.00' }
                },
                'A1:E1',
                { date1904: true, extension }
            );
            assert.equal(
                await extractText(filePath, { locale: 'tr-TR' }),
                '1\t1904-01-01\t1904-01-02 12:00\t12:00\t36:00:00\t1.234,50'
            );
        });
    }
});

test('unsupported formats fall back without losing other cells or cached formula values', async () => {
    const filePath = writeWorkbook(
        {
            A1: { t: 'n', v: 12.5, z: '0.00;0.00;0.00;@;@' },
            B1: { t: 'n', v: 6, f: '2*3', z: '0.00' },
            C1: { t: 'b', v: true },
            D1: { t: 'e', v: 0x07 }
        },
        'A1:D1'
    );
    assert.equal(await extractText(filePath, { locale: 'tr-TR' }), '1\t12.5\t6,00\tTRUE\t#DIV/0!');
});
