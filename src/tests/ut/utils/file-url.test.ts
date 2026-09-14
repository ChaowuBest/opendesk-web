import { filePathToFileUrl, fileUrlToFilePath } from '../../../common/file-url.js';

describe('fileUrlToFilePath', () => {
    test.each([
        ['file:///tmp/%E6%8A%A5%E5%91%8A%20%231.html#L12', '/tmp/报告 #1.html'],
        ['file://localhost/tmp/report.html', '/tmp/report.html'],
        ['file:///C:/Users/Alice/report%20one.html', 'C:/Users/Alice/report one.html'],
        ['file://server/share/report.html', '//server/share/report.html'],
        ['file:///tmp/literal%2520.html', '/tmp/literal%20.html']
    ])('decodes %s once without treating URL fragments as filenames', (url, expected) => {
        expect(fileUrlToFilePath(url)).toBe(expected);
    });

    test.each([
        'https://example.com/',
        'javascript:void(0)',
        'file:///tmp/%ZZ',
        'file:///tmp/a%2fb',
        'file:///tmp/a%00b'
    ])('rejects non-file or ambiguous file URLs: %s', (url) => {
        expect(fileUrlToFilePath(url)).toBeUndefined();
    });
});

describe('filePathToFileUrl', () => {
    test('encodes URL delimiters and Unicode in POSIX paths', () => {
        expect(filePathToFileUrl('/tmp/报告 #1?.html')).toBe('file:///tmp/%E6%8A%A5%E5%91%8A%20%231%3F.html');
    });

    test('converts Windows drive paths', () => {
        expect(filePathToFileUrl('C:\\Users\\Alice\\报告 #1.html')).toBe(
            'file:///C:/Users/Alice/%E6%8A%A5%E5%91%8A%20%231.html'
        );
    });

    test('converts Windows UNC paths without losing the host', () => {
        expect(filePathToFileUrl('\\\\server\\share\\报告.html')).toBe('file://server/share/%E6%8A%A5%E5%91%8A.html');
    });
});
