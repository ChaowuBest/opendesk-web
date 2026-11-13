import { appendAutomatedDownloadsToToolResult } from '../../../main/applications/browser/app.js';

/**
 * 回归测试（压测发现）：navigate 到"会触发下载的资源"时，Chromium 只下载、
 * 不导航。下载信息由 _withAutomatedDownloads 包装层附加到工具结果里，但那段
 * 逻辑此前只处理 JSON 结果——浏览器工具早已改成 YAML 行文本，于是下载提示
 * 被整体丢掉：agent 看到的是"URL 还是旧页面"，既不知道原因，也不知道文件
 * 已经落盘，重试还会重复下载。
 */

const sampleDownload = {
    id: 'dl_1',
    url: 'http://127.0.0.1:18080/shot.png',
    filename: 'shot.png',
    savePath: 'D:/Downloads/shot.png',
    receivedBytes: 863112,
    totalBytes: 863112,
    state: 'completed',
    startTime: 1,
    endTime: 2
} as any;

describe('appendAutomatedDownloadsToToolResult', () => {
    test('YAML 行结果（浏览器工具）追加 downloads 行', () => {
        const result = '- url: http://example.com/old\n- title: Old Page';

        const merged = appendAutomatedDownloadsToToolResult(result, [sampleDownload]);

        expect(merged).toContain('- url: http://example.com/old');
        expect(merged).toContain('- downloads: ');
        expect(merged).toContain('shot.png');
        expect(merged.split('\n').pop()).toContain('863112');
    });

    test('JSON 结果仍走原有合并逻辑', () => {
        const result = JSON.stringify({ status: 'ok', downloads: [{ id: 'old' }] });

        const merged = JSON.parse(appendAutomatedDownloadsToToolResult(result, [sampleDownload]));

        expect(merged.status).toBe('ok');
        expect(merged.downloads).toHaveLength(2);
        expect(merged.downloads[1].filename).toBe('shot.png');
    });

    test('没有下载时原样返回', () => {
        const result = '- url: http://example.com/old';
        expect(appendAutomatedDownloadsToToolResult(result, [])).toBe(result);
    });

    test('既不是 JSON 也不是 YAML 的纯文本不会被破坏', () => {
        const result = '页面加载失败: ERR_CONNECTION_REFUSED';
        expect(appendAutomatedDownloadsToToolResult(result, [sampleDownload])).toBe(result);
    });
});
