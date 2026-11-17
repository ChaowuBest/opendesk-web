import { describe, expect, test } from '@jest/globals';

/**
 * Git LFS pointer 解引用的纯函数部分：
 * - raw 直链对 LFS 文件返回的是 pointer 文本（`version https://git-lfs…` 开头的小段文本），
 *   客户端要认出它、解析出 oid/size，再走仓库的 LFS batch API 换回真实文件的下载地址；
 * - batch 端点按 Git LFS 标准约定从仓库地址推导（`{owner}/{repo}.git/info/lfs/objects/batch`）。
 */

const {
    looksLikeLfsPointerStart,
    parseLfsPointer,
    resolveLfsBatchUrl,
    normalizeGitCodeRawUrl,
    normalizeGitDownloadUrl,
    describeGitHostUrl,
    takeLfsPointer,
    resolveResponseLfs,
    LfsResolveError
} = await import('../../../common/git-lfs.js');

const POINTER = [
    'version https://git-lfs.github.com/spec/v1',
    'oid sha256:28042189c69e9905ec5daa27496170f7651d6d7d1b769b4af2a7640dab6a0012',
    'size 8161876',
    ''
].join('\n');

describe('looksLikeLfsPointerStart', () => {
    test('pointer 版本行开头命中', () => {
        const head = new TextEncoder().encode(POINTER);
        expect(looksLikeLfsPointerStart(head)).toBe(true);
    });

    test('内容不足以判定前缀时返回候选，交给调用方继续累积', () => {
        const head = new TextEncoder().encode('version https://git-');
        expect(looksLikeLfsPointerStart(head)).toBe(true);
    });

    test('zip / gzip / 其它二进制不命中', () => {
        expect(looksLikeLfsPointerStart(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
        expect(looksLikeLfsPointerStart(new Uint8Array([0x1f, 0x8b]))).toBe(false);
        expect(looksLikeLfsPointerStart(new TextEncoder().encode('{"error":"nope"}'))).toBe(false);
        expect(looksLikeLfsPointerStart(new Uint8Array())).toBe(false);
    });
});

describe('parseLfsPointer', () => {
    test('解析标准 pointer 文本', () => {
        expect(parseLfsPointer(POINTER)).toEqual({
            oid: '28042189c69e9905ec5daa27496170f7651d6d7d1b769b4af2a7640dab6a0012',
            size: 8161876
        });
    });

    test('容忍多余字段与顺序变化', () => {
        const text = [
            'version https://git-lfs.github.com/spec/v1',
            'oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'size 123',
            'content echo-b64==',
            ''
        ].join('\n');
        expect(parseLfsPointer(text)).toEqual({
            oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            size: 123
        });
    });

    test('缺 oid / size 或格式不对时返回 null', () => {
        expect(parseLfsPointer('version https://git-lfs.github.com/spec/v1\n')).toBeNull();
        expect(parseLfsPointer('oid sha256:' + 'a'.repeat(64) + '\nsize 1\n')).toBeNull();
        expect(parseLfsPointer('oid md5:abc\nsize 1\n')).toBeNull();
        expect(parseLfsPointer('not a pointer\n')).toBeNull();
    });
});

describe('resolveLfsBatchUrl', () => {
    test('从 GitCode raw API 直链推导', () => {
        expect(
            resolveLfsBatchUrl(
                'https://gitcode.com/api/v5/repos/OpenDesk-Community/official-benchmark-registry/raw/zips/a.zip?ref=main'
            )
        ).toBe('https://gitcode.com/OpenDesk-Community/official-benchmark-registry.git/info/lfs/objects/batch');
    });

    test('从普通 raw / blob 链接推导', () => {
        expect(resolveLfsBatchUrl('https://gitcode.com/org/repo/raw/main/a.zip')).toBe(
            'https://gitcode.com/org/repo.git/info/lfs/objects/batch'
        );
        expect(resolveLfsBatchUrl('https://github.com/org/repo/raw/main/a.zip')).toBe(
            'https://github.com/org/repo.git/info/lfs/objects/batch'
        );
        expect(resolveLfsBatchUrl('https://raw.gitcode.com/org/repo/raw/main/a.zip')).toBe(
            'https://gitcode.com/org/repo.git/info/lfs/objects/batch'
        );
    });

    test('git 远端地址与 `.git` 后缀不重复追加', () => {
        expect(resolveLfsBatchUrl('https://gitcode.com/org/repo.git/raw/main/a.zip')).toBe(
            'https://gitcode.com/org/repo.git/info/lfs/objects/batch'
        );
    });

    test('GitHub raw 域名直链推导到 github.com 的 batch 端点', () => {
        expect(resolveLfsBatchUrl('https://raw.githubusercontent.com/org/repo/main/zips/a.zip')).toBe(
            'https://github.com/org/repo.git/info/lfs/objects/batch'
        );
        expect(resolveLfsBatchUrl('https://github.com/org/repo/blob/main/zips/a.zip')).toBe(
            'https://github.com/org/repo.git/info/lfs/objects/batch'
        );
    });

    test('多平台 raw/blob 直链统一推导（GitLab / Gitee / Gitea / Codeberg / Bitbucket）', () => {
        // GitLab：'-/' 分隔段 + raw|blob
        expect(resolveLfsBatchUrl('https://gitlab.com/org/repo/-/raw/main/zips/a.zip')).toBe(
            'https://gitlab.com/org/repo.git/info/lfs/objects/batch'
        );
        expect(resolveLfsBatchUrl('https://gitlab.com/org/repo/-/blob/main/zips/a.zip')).toBe(
            'https://gitlab.com/org/repo.git/info/lfs/objects/batch'
        );
        // Gitee / Bitbucket：GitHub 同构
        expect(resolveLfsBatchUrl('https://gitee.com/org/repo/raw/master/zips/a.zip')).toBe(
            'https://gitee.com/org/repo.git/info/lfs/objects/batch'
        );
        expect(resolveLfsBatchUrl('https://bitbucket.org/org/repo/raw/main/a.zip')).toBe(
            'https://bitbucket.org/org/repo.git/info/lfs/objects/batch'
        );
        // Gitea / Forgejo / Codeberg：raw/branch/{branch} 与 src/branch/{branch}
        expect(resolveLfsBatchUrl('https://gitea.example.com/org/repo/raw/branch/main/zips/a.zip')).toBe(
            'https://gitea.example.com/org/repo.git/info/lfs/objects/batch'
        );
        expect(resolveLfsBatchUrl('https://codeberg.org/org/repo/src/branch/main/zips/a.zip')).toBe(
            'https://codeberg.org/org/repo.git/info/lfs/objects/batch'
        );
        // 自建 Gitea 子路径部署（/{host}/{base}/{owner}/{repo}/…）无法从 URL 唯一确定
        // owner/repo 的起点，这里不做猜测：返回 null，仓库地址请使用不带子路径前缀的形态
        expect(resolveLfsBatchUrl('https://git.example.com/base/org/repo/raw/main/a.zip')).toBeNull();
    });

    test('无关地址返回 null', () => {
        expect(resolveLfsBatchUrl('https://cdn.example.com/files/a.zip')).toBeNull();
        expect(resolveLfsBatchUrl('http://127.0.0.1:8000/a.zip')).toBeNull();
        expect(resolveLfsBatchUrl('')).toBeNull();
    });
});

describe('describeGitHostUrl', () => {
    test('解析 owner / repo / 主站 origin / 锚点', () => {
        expect(describeGitHostUrl('https://github.com/org/repo/raw/main/a.zip')).toEqual({
            origin: 'https://github.com',
            owner: 'org',
            repo: 'repo',
            anchor: 'raw'
        });
        expect(describeGitHostUrl('https://gitlab.com/org/repo/-/blob/main/a.zip')).toEqual({
            origin: 'https://gitlab.com',
            owner: 'org',
            repo: 'repo',
            anchor: 'blob'
        });
        expect(describeGitHostUrl('https://gitcode.com/api/v5/repos/org/repo/raw/zips/a.zip?ref=main')).toEqual({
            origin: 'https://gitcode.com',
            owner: 'org',
            repo: 'repo',
            anchor: 'raw'
        });
    });

    test('仓库名的 .git 后缀被剥掉', () => {
        expect(describeGitHostUrl('https://github.com/org/repo.git/raw/main/a.zip')?.repo).toBe('repo');
    });
});

describe('normalizeGitDownloadUrl', () => {
    test('组合归一：GitCode raw 与 GitHub blob 各自落到可用直链', () => {
        expect(normalizeGitDownloadUrl('https://raw.gitcode.com/org/repo/raw/main/zips/a.zip')).toBe(
            'https://gitcode.com/api/v5/repos/org/repo/raw/zips/a.zip?ref=main'
        );
        expect(normalizeGitDownloadUrl('https://github.com/org/repo/blob/main/zips/a.zip')).toBe(
            'https://github.com/org/repo/raw/main/zips/a.zip'
        );
        expect(normalizeGitDownloadUrl('https://github.com/org/repo/blob/v1.0.0/a.zip')).toBe(
            'https://github.com/org/repo/raw/v1.0.0/a.zip'
        );
    });

    test('多平台 blob/src 网页锚点统一替换为 raw', () => {
        expect(normalizeGitDownloadUrl('https://gitlab.com/org/repo/-/blob/main/zips/a.zip')).toBe(
            'https://gitlab.com/org/repo/-/raw/main/zips/a.zip'
        );
        expect(normalizeGitDownloadUrl('https://codeberg.org/org/repo/src/branch/main/zips/a.zip')).toBe(
            'https://codeberg.org/org/repo/raw/branch/main/zips/a.zip'
        );
    });

    test('raw 直链路径里的 src / blob 目录不被误当成锚点改写', () => {
        expect(normalizeGitDownloadUrl('https://github.com/org/repo/raw/main/src/plugin.zip')).toBe(
            'https://github.com/org/repo/raw/main/src/plugin.zip'
        );
        expect(normalizeGitDownloadUrl('https://gitee.com/org/repo/raw/master/blob/data.zip')).toBe(
            'https://gitee.com/org/repo/raw/master/blob/data.zip'
        );
        expect(normalizeGitDownloadUrl('https://gitlab.com/org/repo/-/raw/main/src/a.zip')).toBe(
            'https://gitlab.com/org/repo/-/raw/main/src/a.zip'
        );
    });

    test('非锚点形态与其它域名原样返回', () => {
        expect(normalizeGitDownloadUrl('https://github.com/org/repo/raw/main/a.zip')).toBe(
            'https://github.com/org/repo/raw/main/a.zip'
        );
        expect(normalizeGitDownloadUrl('https://raw.githubusercontent.com/org/repo/main/a.zip')).toBe(
            'https://raw.githubusercontent.com/org/repo/main/a.zip'
        );
        expect(normalizeGitDownloadUrl('https://example.com/a.zip')).toBe('https://example.com/a.zip');
        expect(normalizeGitDownloadUrl('https://mirror.example.com/files/a.zip')).toBe(
            'https://mirror.example.com/files/a.zip'
        );
    });
});

describe('normalizeGitCodeRawUrl', () => {
    test('raw.gitcode.com 主干直链等价换到 api/v5 端点', () => {
        expect(normalizeGitCodeRawUrl('https://raw.gitcode.com/org/repo/raw/main/a.zip')).toBe(
            'https://gitcode.com/api/v5/repos/org/repo/raw/a.zip?ref=main'
        );
    });

    test('子目录与已带 query 的地址保持内容', () => {
        expect(normalizeGitCodeRawUrl('https://raw.gitcode.com/org/repo/raw/main/zips/a.tar.gz')).toBe(
            'https://gitcode.com/api/v5/repos/org/repo/raw/zips/a.tar.gz?ref=main'
        );
        expect(normalizeGitCodeRawUrl('https://raw.gitcode.com/org/repo/raw/main/a.zip?download=1')).toBe(
            'https://gitcode.com/api/v5/repos/org/repo/raw/a.zip?download=1'
        );
    });

    test('路径里已编码的字符不被二次编码（%20 → %2520 会 404）', () => {
        expect(normalizeGitCodeRawUrl('https://raw.gitcode.com/org/repo/raw/main/zips/a%20b.zip')).toBe(
            'https://gitcode.com/api/v5/repos/org/repo/raw/zips/a%20b.zip?ref=main'
        );
        expect(
            normalizeGitCodeRawUrl('https://raw.gitcode.com/org/repo/raw/main/zips/%E6%8F%92%E4%BB%B6-1.0.zip')
        ).toBe('https://gitcode.com/api/v5/repos/org/repo/raw/zips/%E6%8F%92%E4%BB%B6-1.0.zip?ref=main');
        expect(normalizeGitDownloadUrl('https://github.com/org/repo/blob/main/zips/a%20b.zip')).toBe(
            'https://github.com/org/repo/raw/main/zips/a%20b.zip'
        );
    });

    test('其它域名与非 raw 形态原样返回', () => {
        expect(normalizeGitCodeRawUrl('https://gitcode.com/api/v5/repos/org/repo/raw/a.zip?ref=main')).toBe(
            'https://gitcode.com/api/v5/repos/org/repo/raw/a.zip?ref=main'
        );
        expect(normalizeGitCodeRawUrl('https://example.com/files/a.zip')).toBe('https://example.com/files/a.zip');
        expect(normalizeGitCodeRawUrl('https://raw.gitcode.com/org/repo')).toBe('https://raw.gitcode.com/org/repo');
        expect(normalizeGitCodeRawUrl('')).toBe('');
    });
});

describe('takeLfsPointer', () => {
    const makeResponse = (chunks: Uint8Array[]) =>
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(chunk);
                    controller.close();
                }
            })
        );

    test('pointer 响应解析出 oid/size', async () => {
        const pointer = Buffer.from(POINTER, 'utf8');
        const result = await takeLfsPointer(
            makeResponse([new Uint8Array(pointer.subarray(0, 10)), new Uint8Array(pointer.subarray(10))])
        );
        expect(result.pointer).toEqual({
            oid: '28042189c69e9905ec5daa27496170f7651d6d7d1b769b4af2a7640dab6a0012',
            size: 8161876
        });
    });

    test('普通文件返回 null，且拼回的流保留完整字节', async () => {
        const body = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const result = await takeLfsPointer(makeResponse([body.subarray(0, 4), body.subarray(4)]));
        expect(result.pointer).toBeNull();
        expect(result.stream).toBeTruthy();
        const reader = result.stream!.getReader();
        const received: number[] = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received.push(...value);
        }
        expect(received).toEqual([...body]);
    });

    test('包装流被 cancel 时底层流一并释放（连接才能回连接池）', async () => {
        let cancelled = false;
        const body = new Uint8Array([1, 2, 3, 4, 5]);
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(body);
                    // 不 close：模拟持续下载中的响应被中途取消
                },
                cancel() {
                    cancelled = true;
                }
            })
        );
        const result = await takeLfsPointer(response);
        expect(result.pointer).toBeNull();
        const reader = result.stream!.getReader();
        await reader.read();
        await reader.cancel();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(cancelled).toBe(true);
    });

    test('包装流按需拉取底层流，不把整个响应体预读进内存', async () => {
        let pulls = 0;
        // 首块不短于版本行长度：peek 一块就能否定 pointer 候选
        const chunk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array<number>(40).fill(0)]);
        const response = new Response(
            new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulls += 1;
                    controller.enqueue(chunk);
                    if (pulls >= 5) controller.close();
                }
            })
        );
        const result = await takeLfsPointer(response);
        expect(result.pointer).toBeNull();
        // 给任何形式的「后台预读」留出跑完的时间窗，再量测：预读实现会把 5 块全部抽干
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(pulls).toBeLessThan(5);
        const reader = result.stream!.getReader();
        const { value } = await reader.read();
        expect([...value!]).toEqual([...chunk]);
    });
});

describe('resolveResponseLfs', () => {
    const jsonResponse = (payload: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(payload), {
            ...init,
            headers: { 'content-type': 'application/vnd.git-lfs+json', ...(init?.headers ?? {}) }
        });

    test('普通文件响应原样放行（不请求 batch）', async () => {
        let batchCalled = false;
        const response = new Response(new Uint8Array([0x50, 0x4b]));
        const lfs = await resolveResponseLfs(response, 'https://gitcode.com/org/repo/raw/main/a.zip', async () => {
            batchCalled = true;
            return jsonResponse({});
        });
        expect(batchCalled).toBe(false);
        expect(lfs.response).toBe(response);
        expect(lfs.stream).toBeTruthy();
    });

    test('pointer 响应解引用后重下载，batch 要求的头并入请求', async () => {
        const seen: Array<{ url: string; init?: RequestInit }> = [];
        const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
            const url = String(input);
            seen.push({ url, init });
            if (url === 'https://gitcode.com/org/repo/raw/main/a.zip') {
                return new Response(POINTER);
            }
            if (url === 'https://gitcode.com/org/repo.git/info/lfs/objects/batch') {
                return jsonResponse({
                    objects: [
                        {
                            actions: {
                                download: {
                                    href: 'https://cdn.example.com/lfs/abc',
                                    header: { Authorization: 'Bearer cdn' }
                                }
                            }
                        }
                    ]
                });
            }
            if (url === 'https://cdn.example.com/lfs/abc') {
                return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
            }
            return new Response('not found', { status: 404 });
        }) as typeof fetch;

        const first = await fetchImpl('https://gitcode.com/org/repo/raw/main/a.zip');
        const lfs = await resolveResponseLfs(first, 'https://gitcode.com/org/repo/raw/main/a.zip', fetchImpl, {
            headers: { accept: 'application/octet-stream' }
        });

        expect(seen.map((item) => item.url)).toEqual([
            'https://gitcode.com/org/repo/raw/main/a.zip',
            'https://gitcode.com/org/repo.git/info/lfs/objects/batch',
            'https://cdn.example.com/lfs/abc'
        ]);
        expect((seen[2].init?.headers as Record<string, string>).Authorization).toBe('Bearer cdn');
        const reader = lfs.stream!.getReader();
        const { value } = await reader.read();
        expect([...value!]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    });

    test('重下载失败抛 LfsResolveError 并取消响应体', async () => {
        const fetchImpl = (async (input: string | URL) => {
            const url = String(input);
            if (url === 'https://gitcode.com/org/repo/raw/main/a.zip') return new Response(POINTER);
            if (url === 'https://gitcode.com/org/repo.git/info/lfs/objects/batch') {
                return jsonResponse({
                    objects: [{ actions: { download: { href: 'https://cdn.example.com/lfs/abc' } } }]
                });
            }
            return new Response('gone', { status: 410 });
        }) as typeof fetch;
        const first = await fetchImpl('https://gitcode.com/org/repo/raw/main/a.zip');
        await expect(
            resolveResponseLfs(first, 'https://gitcode.com/org/repo/raw/main/a.zip', fetchImpl)
        ).rejects.toThrow(LfsResolveError);
    });

    test('非 git 托管地址无法推导 batch 端点时抛 LfsResolveError', async () => {
        const fetchImpl = (async () => new Response(POINTER)) as typeof fetch;
        const first = await fetchImpl('https://mirror.example.com/files/a.zip');
        await expect(resolveResponseLfs(first, 'https://mirror.example.com/files/a.zip', fetchImpl)).rejects.toThrow(
            'not a git host URL'
        );
    });

    test('batch 请求失败时取消响应体并抛 LfsResolveError', async () => {
        let bodyCancelled = false;
        const fetchImpl = (async (input: string | URL) => {
            const url = String(input);
            if (url === 'https://gitcode.com/org/repo/raw/main/a.zip') return new Response(POINTER);
            return new Response(
                new ReadableStream<Uint8Array>({
                    start() {},
                    cancel() {
                        bodyCancelled = true;
                    }
                }),
                { status: 503 }
            );
        }) as typeof fetch;
        const first = await fetchImpl('https://gitcode.com/org/repo/raw/main/a.zip');
        await expect(
            resolveResponseLfs(first, 'https://gitcode.com/org/repo/raw/main/a.zip', fetchImpl)
        ).rejects.toThrow(LfsResolveError);
        expect(bodyCancelled).toBe(true);
    });

    test('batch 返回对象级错误时透出服务端消息', async () => {
        const fetchImpl = (async (input: string | URL) => {
            const url = String(input);
            if (url === 'https://gitcode.com/org/repo/raw/main/a.zip') return new Response(POINTER);
            return jsonResponse({ objects: [{ error: { code: 404, message: 'Object does not exist' } }] });
        }) as typeof fetch;
        const first = await fetchImpl('https://gitcode.com/org/repo/raw/main/a.zip');
        await expect(
            resolveResponseLfs(first, 'https://gitcode.com/org/repo/raw/main/a.zip', fetchImpl)
        ).rejects.toThrow('Object does not exist');
    });
});
