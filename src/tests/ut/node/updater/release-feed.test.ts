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
        'http://114.212.84.8/news/'
    );

    assert.deepEqual(release, {
        version: '0.3.7',
        installerUrl: 'http://114.212.84.8/OpenDesk/releases/download/v0.3.7/opendesk-win-x86-0.3.7.exe',
        installerName: 'opendesk-win-x86-0.3.7.exe',
        sha256,
        notes: 'OpenDesk 0.3.7：测试更新服务'
    });
});

test('fetchLatestRelease accepts the official news HTML contract from the temporary test host', async () => {
    const fetchImpl = async () =>
        new Response(
            `<li data-release-category="stable-release"><article>
                <span class="release-item__title">OpenDesk 0.3.7</span>
                <div class="release-downloads">
                    <a href="http://114.212.84.8/OpenDesk/releases/download/v0.3.7/opendesk-win-x86-0.3.7.exe">Windows x86 安装包</a>
                </div>
            </article></li>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
        );

    const release = await fetchLatestRelease('http://114.212.84.8/news/', fetchImpl as typeof fetch);

    assert.equal(release.version, '0.3.7');
    assert.equal(release.installerName, 'opendesk-win-x86-0.3.7.exe');
});

test('fetchLatestRelease rejects an arbitrary HTTP feed', async () => {
    await assert.rejects(
        fetchLatestRelease('http://updates.example.test/news/', async () => new Response('{}')),
        /HTTPS/
    );
});
