import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { saveTaskExportHtml } from '../../../main/utils/export-html-writer.js';

describe('saveTaskExportHtml', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-export-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('把字体 file:// URL 内联为 data URI 后写盘', async () => {
        const fontPath = path.join(tempDir, 'MapleMono.woff2');
        fs.writeFileSync(fontPath, Buffer.from([1, 2, 3, 4]));
        const fontUrl = pathToFileURL(fontPath).href;
        const html = `<html><style>@font-face { src: url(${fontUrl}) }</style></html>`;
        const target = path.join(tempDir, 'out', 'task.html');

        await saveTaskExportHtml(target, html, [fontUrl]);

        const written = fs.readFileSync(target, 'utf-8');
        expect(written).toContain('data:font/woff2;base64,');
        expect(written).not.toContain(fontUrl);
    });

    test('无法解析的字体 URL 保持原样', async () => {
        const html = `<html><style>@font-face { src: url(https://fonts.example.com/a.woff2) }</style></html>`;
        const target = path.join(tempDir, 'task.html');

        await saveTaskExportHtml(target, html, ['https://fonts.example.com/a.woff2']);

        const written = fs.readFileSync(target, 'utf-8');
        expect(written).toContain('https://fonts.example.com/a.woff2');
        expect(written).not.toContain('data:');
    });

    test('fontUrls 缺省或非数组时不影响写盘', async () => {
        const target = path.join(tempDir, 'task.html');
        await saveTaskExportHtml(target, '<html></html>', undefined);
        expect(fs.readFileSync(target, 'utf-8')).toBe('<html></html>');
    });

    test('非法参数抛出错误', async () => {
        await expect(saveTaskExportHtml('', '<html></html>', [])).rejects.toThrow('invalid export file path');
        await expect(saveTaskExportHtml(path.join(tempDir, 'a.html'), '', [])).rejects.toThrow('invalid export html');
    });
});
