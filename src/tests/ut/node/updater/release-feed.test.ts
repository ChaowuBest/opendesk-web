import assert from 'node:assert/strict';
import test from 'node:test';
import {
    extractReleaseNotesFromDetailPage,
    fetchLatestRelease,
    fetchReleaseNotesForVersion,
    findNewsReleaseEntry,
    parseNewsReleasePage,
    parseReleaseResponse
} from '../../../../main/updater/release-feed.js';

test('parseReleaseResponse selects the Windows release installer from GitCode', () => {
    const sha256 = 'b'.repeat(64);
    const release = parseReleaseResponse({
        tag_name: 'v0.3.6',
        prerelease: false,
        body: `Release notes\n\n${sha256}  opendesk-win-x86-0.3.6.exe`,
        assets: [
            { name: 'Source code.zip', browser_download_url: 'https://gitcode.com/source.zip', size: 1 },
            {
                name: 'opendesk-win-x86-0.3.6.exe',
                browser_download_url:
                    'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.6/opendesk-win-x86-0.3.6.exe',
                size: 123
            }
        ]
    });

    assert.deepEqual(release, {
        version: '0.3.6',
        installerUrl:
            'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.6/opendesk-win-x86-0.3.6.exe',
        installerName: 'opendesk-win-x86-0.3.6.exe',
        size: 123,
        sha256,
        notes: `Release notes\n\n${sha256}  opendesk-win-x86-0.3.6.exe`
    });
});

test('parseReleaseResponse accepts a checksum manifest and rejects unsafe releases', () => {
    const sha256 = 'a'.repeat(64);
    assert.equal(
        parseReleaseResponse({
            version: '0.3.7',
            url: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
            sha256
        }).sha256,
        sha256
    );

    assert.throws(
        () => parseReleaseResponse({ version: '0.3.7', url: 'http://updates.example.test/update.exe' }),
        /HTTPS/
    );
    assert.throws(
        () => parseReleaseResponse({ tag_name: 'v0.3.7-beta.1', prerelease: true, assets: [] }),
        /prerelease/
    );
});

test('trusted-source release parsing ignores malformed checksum metadata', () => {
    const release = parseReleaseResponse(
        {
            version: '0.3.7',
            url: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
            sha256: 'not-used-by-this-release'
        },
        'trusted-source'
    );

    assert.equal(release.sha256, undefined);
    assert.throws(
        () =>
            parseReleaseResponse({
                version: '0.3.7',
                url: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
                sha256: 'not-used-by-this-release'
            }),
        /SHA-256/
    );
});

test('parseNewsReleasePage reads the latest stable Windows x86 release from the public news markup', () => {
    const sha256 = 'c'.repeat(64);
    const release = parseNewsReleasePage(
        `<!doctype html><html><body><ol class="release-list">
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.3.7：测试更新服务</span>
                <div class="release-downloads">
                    <a href="/OpenDesk/releases/download/v0.3.7/opendesk-win-x86-0.3.7.exe" data-sha256="${sha256}">Windows x86 安装包</a>
                    <a href="/OpenDesk/releases/download/v0.3.7/opendesk-darwin-arm64-0.3.7.dmg">MacOS 安装包</a>
                </div>
            </article></li>
            <li data-release-category="nightly-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 9.9.9 nightly</span>
                <div class="release-downloads"><a href="/nightly.exe">Windows x86 安装包</a></div>
            </article></li>
        </ol></body></html>`,
        'https://opendesk.matrix.openharmony.cn/news/'
    );

    assert.deepEqual(release, {
        version: '0.3.7',
        installerUrl:
            'https://opendesk.matrix.openharmony.cn/OpenDesk/releases/download/v0.3.7/opendesk-win-x86-0.3.7.exe',
        installerName: 'opendesk-win-x86-0.3.7.exe',
        sha256,
        notes: 'OpenDesk 0.3.7：测试更新服务'
    });
});

test('parseNewsReleasePage selects the native ARM64 installer for arm64 targets', () => {
    const release = parseNewsReleasePage(
        `<!doctype html><html><body><ol class="release-list">
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.3.8：双架构发布</span>
                <div class="release-downloads">
                    <a href="/OpenDesk/releases/download/v0.3.8/opendesk-win-x86-0.3.8.exe">Windows x86 安装包</a>
                    <a href="/OpenDesk/releases/download/v0.3.8/opendesk-win-arm64-0.3.8.exe">Windows ARM64 安装包</a>
                </div>
            </article></li>
        </ol></body></html>`,
        'https://opendesk.matrix.openharmony.cn/news/',
        'strict',
        'arm64'
    );

    assert.equal(
        release.installerUrl,
        'https://opendesk.matrix.openharmony.cn/OpenDesk/releases/download/v0.3.8/opendesk-win-arm64-0.3.8.exe'
    );
    assert.equal(release.installerName, 'opendesk-win-arm64-0.3.8.exe');
});

test('parseNewsReleasePage falls back to the x86 installer for arm64 targets on legacy feeds', () => {
    const release = parseNewsReleasePage(
        `<!doctype html><html><body><ol class="release-list">
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.3.6：仅 x86 发布</span>
                <div class="release-downloads">
                    <a href="/OpenDesk/releases/download/v0.3.6/opendesk-win-x86-0.3.6.exe">Windows x86 安装包</a>
                </div>
            </article></li>
        </ol></body></html>`,
        'https://opendesk.matrix.openharmony.cn/news/',
        'strict',
        'arm64'
    );

    assert.equal(
        release.installerUrl,
        'https://opendesk.matrix.openharmony.cn/OpenDesk/releases/download/v0.3.6/opendesk-win-x86-0.3.6.exe'
    );
});

test('parseNewsReleasePage keeps selecting the x86 installer for x64 targets', () => {
    const release = parseNewsReleasePage(
        `<!doctype html><html><body><ol class="release-list">
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.3.8：双架构发布</span>
                <div class="release-downloads">
                    <a href="/OpenDesk/releases/download/v0.3.8/opendesk-win-arm64-0.3.8.exe">Windows ARM64 安装包</a>
                    <a href="/OpenDesk/releases/download/v0.3.8/opendesk-win-x86-0.3.8.exe">Windows x86 安装包</a>
                </div>
            </article></li>
        </ol></body></html>`,
        'https://opendesk.matrix.openharmony.cn/news/',
        'strict',
        'x64'
    );

    assert.equal(
        release.installerUrl,
        'https://opendesk.matrix.openharmony.cn/OpenDesk/releases/download/v0.3.8/opendesk-win-x86-0.3.8.exe'
    );
});

test('parseNewsReleasePage reports the requested architecture when no installer matches', () => {
    assert.throws(
        () =>
            parseNewsReleasePage(
                `<!doctype html><html><body><ol class="release-list">
                    <li data-release-category="stable-release"><article class="release-item">
                        <span class="release-item__title">OpenDesk 0.3.6</span>
                        <div class="release-downloads">
                            <a href="/OpenDesk/releases/download/v0.3.6/opendesk-darwin-x86-0.3.6.dmg">MacOS 安装包</a>
                        </div>
                    </article></li>
                </ol></body></html>`,
                'https://opendesk.matrix.openharmony.cn/news/',
                'strict',
                'arm64'
            ),
        /Windows arm64 release/
    );
});

test('parseReleaseResponse selects architecture-specific GitCode assets', () => {
    const assets = [
        {
            name: 'opendesk-win-x86-0.3.8.exe',
            browser_download_url:
                'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.8/opendesk-win-x86-0.3.8.exe',
            size: 253
        },
        {
            name: 'opendesk-win-arm64-0.3.8.exe',
            browser_download_url:
                'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.8/opendesk-win-arm64-0.3.8.exe',
            size: 231
        }
    ];

    const arm64 = parseReleaseResponse({ tag_name: 'v0.3.8', prerelease: false, assets }, 'strict', 'arm64');
    assert.equal(arm64.installerName, 'opendesk-win-arm64-0.3.8.exe');
    assert.equal(arm64.size, 231);

    const x64 = parseReleaseResponse({ tag_name: 'v0.3.8', prerelease: false, assets }, 'strict', 'x64');
    assert.equal(x64.installerName, 'opendesk-win-x86-0.3.8.exe');
    assert.equal(x64.size, 253);
});

test('parseReleaseResponse falls back to the x86 asset for arm64 targets on legacy releases', () => {
    const release = parseReleaseResponse(
        {
            tag_name: 'v0.3.6',
            prerelease: false,
            assets: [
                {
                    name: 'opendesk-win-x86-0.3.6.exe',
                    browser_download_url:
                        'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.6/opendesk-win-x86-0.3.6.exe',
                    size: 123
                }
            ]
        },
        'strict',
        'arm64'
    );

    assert.equal(release.installerName, 'opendesk-win-x86-0.3.6.exe');
});

test('fetchLatestRelease accepts the official OpenDesk news and GitCode download contract', async () => {
    const fetchImpl = async () =>
        new Response(
            `<li data-release-category="stable-release"><article>
                <span class="release-item__title">OpenDesk 0.3.7</span>
                <div class="release-downloads">
                    <a href="https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.7/opendesk-win-x86-0.3.7.exe">Windows x86 安装包</a>
                </div>
            </article></li>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
        );

    const release = await fetchLatestRelease('https://opendesk.matrix.openharmony.cn/news/', fetchImpl as typeof fetch);

    assert.equal(release.version, '0.3.7');
    assert.equal(release.installerName, 'opendesk-win-x86-0.3.7.exe');
    assert.equal(
        release.installerUrl,
        'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.7/opendesk-win-x86-0.3.7.exe'
    );
});

test('fetchLatestRelease rejects an arbitrary HTTP feed', async () => {
    await assert.rejects(
        fetchLatestRelease('http://updates.example.test/news/', async () => new Response('{}')),
        /HTTPS/
    );
});

test('fetchLatestRelease force-times-out a fetch implementation that never settles', async () => {
    const neverSettles = new Promise<Response>(() => {});
    // 模拟不尊重 AbortSignal 的 fetch 实现（如部分 Electron 适配层）：
    // 既不响应 signal，也永不返回
    const ignoringFetch = (async () => neverSettles) as unknown as typeof fetch;

    // raceWithForceTimeout 的兜底定时器与 AbortSignal.timeout 都不会阻止事件循环退出，
    // node:test 会以 "Promise resolution is still pending" 取消后续所有用例；
    // 这里持有一个 ref 定时器模拟宿主进程的常驻活动，让超时兜底真正被验证。
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
        await assert.rejects(
            fetchLatestRelease('https://updates.example.test/news/', ignoringFetch, 100),
            /Update feed request timed out/
        );
    } finally {
        clearTimeout(keepAlive);
    }
});

test('parseNewsReleasePage selects the Apple Silicon DMG installer for darwin arm64 targets', () => {
    const release = parseNewsReleasePage(
        `<!doctype html><html><body><ol class="release-list">
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.3.10：macOS 更新测试</span>
                <div class="release-downloads">
                    <a href="/OpenDesk/releases/download/v0.3.10/opendesk-win-x86-0.3.10.exe">Windows x86 安装包</a>
                    <a href="/OpenDesk/releases/download/v0.3.10/opendesk-win-arm64-0.3.10.exe">Windows ARM64 安装包</a>
                    <a href="/OpenDesk/releases/download/v0.3.10/opendesk-darwin-arm64-0.3.10.dmg">macOS 安装包 (Apple 芯片)</a>
                    <a href="/OpenDesk/releases/download/v0.3.10/opendesk-darwin-x86-0.3.10.dmg">macOS 安装包 (Intel 芯片)</a>
                </div>
            </article></li>
        </ol></body></html>`,
        'https://opendesk.matrix.openharmony.cn/news/',
        'strict',
        'arm64',
        'darwin'
    );

    assert.equal(
        release.installerUrl,
        'https://opendesk.matrix.openharmony.cn/OpenDesk/releases/download/v0.3.10/opendesk-darwin-arm64-0.3.10.dmg'
    );
    assert.equal(release.installerName, 'opendesk-darwin-arm64-0.3.10.dmg');
});

test('parseNewsReleasePage selects the Intel DMG installer for darwin x64 targets', () => {
    const release = parseNewsReleasePage(
        `<!doctype html><html><body><ol class="release-list">
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.3.10：macOS 更新测试</span>
                <div class="release-downloads">
                    <a href="/OpenDesk/releases/download/v0.3.10/opendesk-darwin-arm64-0.3.10.dmg">macOS 安装包 (Apple 芯片)</a>
                    <a href="/OpenDesk/releases/download/v0.3.10/opendesk-darwin-x86-0.3.10.dmg">macOS 安装包 (Intel 芯片)</a>
                </div>
            </article></li>
        </ol></body></html>`,
        'https://opendesk.matrix.openharmony.cn/news/',
        'strict',
        'x64',
        'darwin'
    );

    assert.equal(
        release.installerUrl,
        'https://opendesk.matrix.openharmony.cn/OpenDesk/releases/download/v0.3.10/opendesk-darwin-x86-0.3.10.dmg'
    );
    assert.equal(release.installerName, 'opendesk-darwin-x86-0.3.10.dmg');
});

test('parseNewsReleasePage rejects a darwin target when the feed only contains Windows installers', () => {
    assert.throws(
        () =>
            parseNewsReleasePage(
                `<!doctype html><html><body><ol class="release-list">
                    <li data-release-category="stable-release"><article class="release-item">
                        <span class="release-item__title">OpenDesk 0.3.10</span>
                        <div class="release-downloads">
                            <a href="/OpenDesk/releases/download/v0.3.10/opendesk-win-x86-0.3.10.exe">Windows x86 安装包</a>
                        </div>
                    </article></li>
                </ol></body></html>`,
                'https://opendesk.matrix.openharmony.cn/news/',
                'strict',
                'arm64',
                'darwin'
            ),
        /macOS arm64 release/
    );
});

test('parseReleaseResponse selects architecture-specific darwin DMG assets', () => {
    const assets = [
        {
            name: 'opendesk-darwin-arm64-0.3.10.dmg',
            browser_download_url:
                'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.10/opendesk-darwin-arm64-0.3.10.dmg',
            size: 201
        },
        {
            name: 'opendesk-darwin-x86-0.3.10.dmg',
            browser_download_url:
                'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.10/opendesk-darwin-x86-0.3.10.dmg',
            size: 199
        },
        {
            name: 'opendesk-win-x86-0.3.10.exe',
            browser_download_url:
                'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.10/opendesk-win-x86-0.3.10.exe',
            size: 123
        }
    ];

    const arm64 = parseReleaseResponse({ tag_name: 'v0.3.10', prerelease: false, assets }, 'strict', 'arm64', 'darwin');
    assert.equal(arm64.installerName, 'opendesk-darwin-arm64-0.3.10.dmg');
    assert.equal(arm64.size, 201);

    const x64 = parseReleaseResponse({ tag_name: 'v0.3.10', prerelease: false, assets }, 'strict', 'x64', 'darwin');
    assert.equal(x64.installerName, 'opendesk-darwin-x86-0.3.10.dmg');
    assert.equal(x64.size, 199);
});

test('parseReleaseResponse keeps ignoring macOS assets for Windows targets', () => {
    assert.throws(
        () =>
            parseReleaseResponse(
                {
                    tag_name: 'v0.3.10',
                    prerelease: false,
                    assets: [
                        {
                            name: 'opendesk-darwin-arm64-0.3.10.dmg',
                            browser_download_url:
                                'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.10/opendesk-darwin-arm64-0.3.10.dmg',
                            size: 201
                        }
                    ]
                },
                'strict',
                'x64',
                'win32'
            ),
        /Windows EXE installer/
    );
});

test('fetchLatestRelease passes the darwin platform through to the news page parser', async () => {
    const fetchImpl = async () =>
        new Response(
            `<li data-release-category="stable-release"><article>
                <span class="release-item__title">OpenDesk 0.3.10</span>
                <div class="release-downloads">
                    <a href="https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.10/opendesk-darwin-arm64-0.3.10.dmg">macOS 安装包 (Apple 芯片)</a>
                </div>
            </article></li>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
        );

    const release = await fetchLatestRelease(
        'https://opendesk.matrix.openharmony.cn/news/',
        fetchImpl as typeof fetch,
        30_000,
        'strict',
        'arm64',
        'darwin'
    );

    assert.equal(release.installerName, 'opendesk-darwin-arm64-0.3.10.dmg');
});

test('fetchLatestRelease still passes the abort signal to fetch implementations that honor it', async () => {
    let receivedSignal: AbortSignal | undefined;
    const capturingFetch = (async (_input: string | URL, init?: RequestInit) => {
        receivedSignal = init?.signal ?? undefined;
        return new Response(
            '<li data-release-category="stable-release"><article>' +
                '<span class="release-item__title">OpenDesk 0.3.7</span>' +
                '<div class="release-downloads">' +
                '<a href="https://gitcode.com/openharmony-robot/OpenDesk/releases/download/v0.3.7/opendesk-win-x86-0.3.7.exe">Windows x86 安装包</a>' +
                '</div></article></li>',
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
    }) as unknown as typeof fetch;

    const release = await fetchLatestRelease('https://updates.example.test/news/', capturingFetch, 5_000);

    assert.equal(release.version, '0.3.7');
    assert.ok(receivedSignal instanceof AbortSignal, 'expected an AbortSignal on the fetch init');
});

test('findNewsReleaseEntry returns the matching stable entry with its safe detail page URL', () => {
    const entry = findNewsReleaseEntry(
        `<!doctype html><html><body><ol class="release-list">
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.4.1：支持鸿蒙PC应用本地开发</span>
                <a href="/news/2026-11-12-stable-release/">阅读全文</a>
            </article></li>
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.4.0：旧版本</span>
                <a href="/news/2026-10-01-stable-release/">阅读全文</a>
            </article></li>
        </ol></body></html>`,
        'https://opendesk.matrix.openharmony.cn/news/',
        '0.4.1'
    );

    assert.deepEqual(entry, {
        title: 'OpenDesk 0.4.1：支持鸿蒙PC应用本地开发',
        notesUrl: 'https://opendesk.matrix.openharmony.cn/news/2026-11-12-stable-release/'
    });
});

test('findNewsReleaseEntry returns undefined when the requested version is absent', () => {
    const entry = findNewsReleaseEntry(
        `<!doctype html><html><body><ol class="release-list">
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.4.1：支持鸿蒙PC应用本地开发</span>
                <a href="/news/2026-11-12-stable-release/">阅读全文</a>
            </article></li>
        </ol></body></html>`,
        'https://opendesk.matrix.openharmony.cn/news/',
        '0.4.2'
    );

    assert.equal(entry, undefined);
});

test('findNewsReleaseEntry drops unsafe detail links instead of failing', () => {
    const entry = findNewsReleaseEntry(
        `<!doctype html><html><body><ol class="release-list">
            <li data-release-category="stable-release"><article class="release-item">
                <span class="release-item__title">OpenDesk 0.4.1：测试更新服务</span>
                <a href="http://updates.example.test/news/fake-release/">阅读全文</a>
            </article></li>
        </ol></body></html>`,
        'https://opendesk.matrix.openharmony.cn/news/',
        '0.4.1'
    );

    assert.deepEqual(entry, { title: 'OpenDesk 0.4.1：测试更新服务', notesUrl: undefined });
});

test('extractReleaseNotesFromDetailPage converts the news detail body into line-marked notes', () => {
    const notes = extractReleaseNotesFromDetailPage(
        `<!doctype html><html><body>
            <h1>OpenDesk 0.4.1：支持鸿蒙PC应用本地开发</h1>
            <div class="download-links"><a href="/download/opendesk-win-x86-0.4.1.exe">Windows 安装包下载</a></div>
            <h1 id="opendesk-041-正式版本更新内容">OpenDesk 0.4.1 正式版本更新内容</h1>
            <h2 id="主要更新">主要更新</h2>
            <p>相对于上个版本，本次更新聚焦稳定性。</p>
            <h2 id="新功能">新功能</h2>
            <ul>
                <li>内置支持 <code>hdcthis</code> 无线调试</li>
                <li>技能支持
                    符号链接</li>
            </ul>
            <h2 id="如何升级">如何升级</h2>
            <p>打开设置中心立即更新。</p>
        </body></html>`,
        'OpenDesk 0.4.1：支持鸿蒙PC应用本地开发'
    );

    assert.equal(
        notes,
        [
            '# OpenDesk 0.4.1：支持鸿蒙PC应用本地开发',
            '',
            '## 主要更新',
            '',
            '相对于上个版本，本次更新聚焦稳定性。',
            '',
            '## 新功能',
            '- 内置支持 hdcthis 无线调试',
            '- 技能支持 符号链接'
        ].join('\n')
    );
});

test('extractReleaseNotesFromDetailPage returns undefined when the detail body heading is missing', () => {
    assert.equal(
        extractReleaseNotesFromDetailPage(
            '<!doctype html><html><body><h1>页面不存在</h1><p>请返回列表页。</p></body></html>',
            'OpenDesk 0.4.1：测试更新服务'
        ),
        undefined
    );
});

test('fetchReleaseNotesForVersion fetches the list entry and its detail page', async () => {
    const listHtml = `<li data-release-category="stable-release"><article>
        <span class="release-item__title">OpenDesk 0.4.1：支持鸿蒙PC应用本地开发</span>
        <a href="/news/2026-11-12-stable-release/">阅读全文</a>
    </article></li>`;
    const detailHtml = `<!doctype html><html><body>
        <h1>OpenDesk 0.4.1：支持鸿蒙PC应用本地开发</h1>
        <h1 id="opendesk-041-正式版本更新内容">OpenDesk 0.4.1 正式版本更新内容</h1>
        <h2 id="新功能">新功能</h2>
        <ul><li>定时任务支持 <code>wait</code> 等待语法</li></ul>
        <h2 id="如何升级">如何升级</h2>
        <p>打开设置中心立即更新。</p>
    </body></html>`;
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
        requested.push(String(input));
        return new Response(requested.length === 1 ? listHtml : detailHtml, {
            headers: { 'content-type': 'text/html; charset=utf-8' }
        });
    }) as unknown as typeof fetch;

    const notes = await fetchReleaseNotesForVersion('https://opendesk.matrix.openharmony.cn/news/', '0.4.1', fetchImpl);

    assert.deepEqual(requested, [
        'https://opendesk.matrix.openharmony.cn/news/',
        'https://opendesk.matrix.openharmony.cn/news/2026-11-12-stable-release/'
    ]);
    assert.equal(
        notes,
        ['# OpenDesk 0.4.1：支持鸿蒙PC应用本地开发', '', '## 新功能', '- 定时任务支持 wait 等待语法'].join('\n')
    );
});

test('fetchReleaseNotesForVersion returns undefined when no news entry matches the version', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
        requested.push(String(input));
        return new Response(
            `<li data-release-category="stable-release"><article>
                <span class="release-item__title">OpenDesk 0.4.1：支持鸿蒙PC应用本地开发</span>
                <a href="/news/2026-11-12-stable-release/">阅读全文</a>
            </article></li>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
    }) as unknown as typeof fetch;

    const notes = await fetchReleaseNotesForVersion('https://opendesk.matrix.openharmony.cn/news/', '0.4.2', fetchImpl);

    assert.equal(notes, undefined);
    assert.deepEqual(requested, ['https://opendesk.matrix.openharmony.cn/news/']);
});

test('fetchReleaseNotesForVersion throws when either request fails', async () => {
    const listHtml = `<li data-release-category="stable-release"><article>
        <span class="release-item__title">OpenDesk 0.4.1：支持鸿蒙PC应用本地开发</span>
        <a href="/news/2026-11-12-stable-release/">阅读全文</a>
    </article></li>`;

    await assert.rejects(
        fetchReleaseNotesForVersion(
            'https://opendesk.matrix.openharmony.cn/news/',
            '0.4.1',
            (async () => new Response('Service Unavailable', { status: 503 })) as typeof fetch
        ),
        /HTTP 503/
    );

    let calls = 0;
    await assert.rejects(
        fetchReleaseNotesForVersion('https://opendesk.matrix.openharmony.cn/news/', '0.4.1', (async () => {
            calls++;
            return calls === 1
                ? new Response(listHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } })
                : new Response('Service Unavailable', { status: 503 });
        }) as unknown as typeof fetch),
        /HTTP 503/
    );
});
