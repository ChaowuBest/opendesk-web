import { createMainWindowContextMenuTemplate } from '../../../main/window-context-menu.js';
import { enUs } from '../../../locale/en-us.js';
import { zhCn } from '../../../locale/zh-cn.js';

describe('main window context menu', () => {
    const labels = {
        openLink: zhCn['contextmenu.openLink'],
        copyLink: zhCn['contextmenu.copyLink'],
        cut: zhCn['contextmenu.cut'],
        copy: zhCn['contextmenu.copy'],
        paste: zhCn['contextmenu.paste'],
        selectAll: zhCn['contextmenu.selectAll']
    };

    test('names the system-browser action clearly in both locales', () => {
        expect(zhCn['contextmenu.openLink']).toBe('用系统浏览器打开');
        expect(enUs['contextmenu.openLink']).toBe('Open in System Browser');
    });

    test('offers open and copy actions for web links', () => {
        const opened: string[] = [];
        const copied: string[] = [];
        const template = createMainWindowContextMenuTemplate(
            { linkURL: 'https://example.com/docs', isEditable: false },
            labels,
            {
                openLink: (url) => opened.push(url),
                copyText: (text) => copied.push(text)
            }
        );

        expect(template.map((item) => item.label)).toEqual(['用系统浏览器打开', '复制链接']);
        template[0].click?.({} as never, {} as never, {} as never);
        template[1].click?.({} as never, {} as never, {} as never);
        expect(opened).toEqual(['https://example.com/docs']);
        expect(copied).toEqual(['https://example.com/docs']);
    });

    test('rejects non-web link schemes', () => {
        expect(
            createMainWindowContextMenuTemplate({ linkURL: 'javascript:alert(1)', isEditable: false }, labels, {
                openLink: () => {},
                copyText: () => {}
            })
        ).toEqual([]);
    });

    test('preserves the editable text menu', () => {
        const template = createMainWindowContextMenuTemplate({ linkURL: '', isEditable: true }, labels, {
            openLink: () => {},
            copyText: () => {}
        });

        expect(template.map((item) => item.role || item.type)).toEqual([
            'cut',
            'copy',
            'paste',
            'separator',
            'selectAll'
        ]);
    });
});
