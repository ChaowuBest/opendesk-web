import { filePathToFileUrl } from '../../../common/file-url.js';

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
