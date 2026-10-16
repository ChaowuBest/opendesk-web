import assert from 'node:assert/strict';
import test from 'node:test';
import {
    compareVersions,
    fetchLatestRelease,
    parseNewsReleasePage,
    parseReleaseResponse
} from '../../../../main/updater/release-feed.js';

test('compareVersions compares stable numeric versions', () => {
    assert.equal(compareVersions('0.3.6', '0.3.5'), 1);
    assert.equal(compareVersions('0.3.5', '0.3.5'), 0);
    assert.equal(compareVersions('0.3.4', '0.3.5'), -1);
    assert.throws(() => compareVersions('0.3.6-beta.1', '0.3.5'), /stable semantic version/);
});

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

    await assert.rejects(
        fetchLatestRelease('https://updates.example.test/news/', ignoringFetch, 100),
        /Update feed request timed out/
    );
});

test('fetchLatestRelease still passes the abort signal to fetch implementations that honor it', async () => {
    let receivedSignal: AbortSignal | undefined;
    const capturingFetch = (async (_input: string | URL, init?: RequestInit) => {
        receivedSignal = init?.signal;
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
