/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Git LFS pointer 的识别与解引用（插件市场与测评集下载共用）。
 *
 * 背景：官方资源仓库把归档包用 Git LFS 托管，而各家平台的 raw 直链对 LFS 文件
 * 都不直接给真身：
 * - GitCode：raw.gitcode.com 预览端点对 LFS 二进制直接 403（先归一成 api/v5 raw 端点）；
 * - GitHub：raw.githubusercontent.com 返回一小段 pointer 文本
 *   （`version https://git-lfs.github.com/spec/v1` + oid/size）。
 * 下载要拿到真身需要：
 * 1. 把网页/预览形态的地址归一成 raw 直链（`normalizeGitDownloadUrl`）；
 * 2. 识别响应是 pointer（`takeLfsPointer`），解析出 oid/size；
 * 3. 按 Git LFS 标准协议 POST 到仓库的 batch 端点换回 CDN 直链
 *   （`resolveLfsDownloadHref`，公开仓库匿名可用；GitHub 上 `github.com/{o}/{r}/raw/…`
 *   形态则会 302 到 media 端点直接给真身，无需走这一步）。
 *
 * 平台适配是数据驱动的（见 RAW_CDN_ORIGINS / RAW_ANCHOR_SEGMENTS / RAW_SKIP_SEGMENTS）：
 * 主流平台的 raw 直链都符合「/{owner}/{repo}/[skip…]{锚点}/[字面段…]{branch}/{path}」结构，
 * `describeGitHostUrl` 做通用解析；接入新平台只需要补域名映射 / 锚点集合，个别平台的
 * 行为级差异（如 GitCode 预览端点 403）才需要专门的归一函数。
 *
 * 本模块只依赖标准库，不含本地化：失败统一抛 `LfsResolveError`，
 * 由调用方（benchmark / pluginmgr）包装成各自的用户文案。
 */

import { toErrorMessage } from './utils/error.js';

/** pointer 的固定版本行（Git LFS 规范） */
export const LFS_POINTER_VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';

/** pointer 恒为几行小文本；匹配版本行后超出该体积视为写坏的 pointer，交由解析失败报错 */
export const LFS_POINTER_MAX_BYTES = 1024 * 1024;

/** batch 解引用请求的超时 */
export const LFS_BATCH_TIMEOUT_MS = 30000;

/** LFS 解引用失败：message 是可拼进用户文案的诊断信息 */
export class LfsResolveError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LfsResolveError';
    }
}

export interface LfsPointer {
    oid: string;
    size: number;
}

export interface TakeLfsPointerResult {
    /** 响应是 pointer 时给出解析结果；普通文件为 null */
    pointer: LfsPointer | null;
    /**
     * 普通文件时返回「拼回已读字节后的完整响应流」，调用方用它替代 response.body；
     * pointer 路径流已被读光，为 null。
     */
    stream: ReadableStream<Uint8Array> | null;
}

/**
 * 响应开头是否还是 pointer 的候选。
 *
 * 首个网络分块可能比版本行还短，此时只能确认「已知的部分仍然匹配」；
 * 真要判定需要调用方继续累积字节（见 takeLfsPointer）。
 */
export function looksLikeLfsPointerStart(head: Uint8Array): boolean {
    const prefix = Buffer.from(LFS_POINTER_VERSION_LINE, 'latin1');
    const comparable = head.length < prefix.length ? head : head.subarray(0, prefix.length);
    if (comparable.length === 0) return false;
    return prefix.subarray(0, comparable.length).equals(Buffer.from(comparable));
}

/** 解析 pointer 文本；缺版本行、缺 oid/size 或格式不对时返回 null */
export function parseLfsPointer(text: string): LfsPointer | null {
    const lines = text.split(/\r?\n/);
    if (!lines.some((line) => line.trim() === LFS_POINTER_VERSION_LINE)) return null;
    let oid: string | null = null;
    let size: number | null = null;
    for (const line of lines) {
        const match = /^(oid|size)\s+(\S+)$/.exec(line.trim());
        if (!match) continue;
        if (match[1] === 'oid') {
            const value = /^sha256:([a-f0-9]{64})$/.exec(match[2]);
            if (!value) return null;
            oid = value[1];
        } else {
            const value = /^(\d+)$/.exec(match[2]);
            if (!value) return null;
            size = Number(value[1]);
        }
    }
    if (!oid || size === null || !Number.isFinite(size) || size <= 0) return null;
    return { oid, size };
}

/**
 * 读取响应开头并判定它是不是 LFS pointer。
 *
 * 需要 peek 是因为网络分块可能把 pointer 拆到多个 chunk，而正常压缩包的首字节
 * 又必然是各自魔数（zip 的 `PK`、gzip 的 `1f 8b`…），不能等全部读完再判断。
 * 判定为普通文件时会把已读字节拼回流的开头原样归还。
 */
export async function takeLfsPointer(response: Response): Promise<TakeLfsPointerResult> {
    const body = response.body;
    if (!body) return { pointer: null, stream: null };
    const reader = body.getReader();
    let buffer = Buffer.alloc(0);
    let confirmed = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = Buffer.concat([buffer, Buffer.from(value)]);
        if (!looksLikeLfsPointerStart(buffer)) break;
        if (buffer.length >= Buffer.byteLength(LFS_POINTER_VERSION_LINE)) {
            confirmed = true;
            break;
        }
    }
    if (!confirmed) {
        return { pointer: null, stream: streamFromParts(buffer, reader) };
    }
    // pointer：把流读完（恒为小文本；超上限视为写坏，交由解析失败报错）
    while (buffer.length <= LFS_POINTER_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = Buffer.concat([buffer, Buffer.from(value)]);
    }
    const pointer = parseLfsPointer(buffer.toString('utf8'));
    if (!pointer) {
        // 内容不是合法 pointer 就不再是我们要的流：取消底层读取，连接立刻回连接池
        await reader.cancel().catch(() => undefined);
        throw new LfsResolveError('malformed LFS pointer');
    }
    return { pointer, stream: null };
}

/**
 * GitCode 的 raw.gitcode.com 是预览端点，对 LFS 二进制直接 403；
 * 主干直链等价换成 api/v5 raw 端点（同一分支同一文件，LFS 会返回 pointer 供解引用）。
 */
export function normalizeGitCodeRawUrl(downloadUrl: string): string {
    const value = downloadUrl.trim();
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return value;
    }
    if (url.protocol !== 'https:' || url.host.toLowerCase() !== 'raw.gitcode.com') return value;
    // 形态：/{owner}/{repo}/raw/{branch}/{path…}。pathname 是编码形态，剩余路径必须原样保留
    // （再 encodeURIComponent 会把 %20 变成 %2520，文件名带空格/中文的地址直接 404）
    const match = /^\/([^/]+)\/([^/]+)\/raw\/([^/]+)(\/.+)$/.exec(url.pathname);
    if (!match) return value;
    const [, owner, repo, branch, rest] = match;
    const api = new URL(`https://gitcode.com/api/v5/repos/${owner}/${repo}/raw${rest}`);
    if (url.search) {
        api.search = url.search;
    } else {
        api.searchParams.set('ref', branch);
    }
    return api.toString();
}

// ── 通用 git 托管形态解析 ────────────────────────────────────────────────────
//
// 主流平台的 raw/blob 直链都长成「/{owner}/{repo}/[分隔段…]{锚点}/[字面段…]{branch}/{path}」，
// 差异只在锚点段与字面段：
// - GitHub / Gitee / Bitbucket：/{owner}/{repo}/raw|blob/{branch}/…
// - GitLab：/{owner}/{repo}/-/raw|blob/{branch}/…（'-' 是无信息分隔段）
// - Gitea / Forgejo / Codeberg：/{owner}/{repo}/raw|src/branch/{branch}/…（'branch' 是字面段）
// 因此用「锚点 + 可跳过段」做通用解析，接入新平台不需要新代码；只有个别平台的
// 特殊端点（如 GitCode 预览域名的 403 行为）需要单独归一。

/** raw/blob 直链里的锚点段：raw 与 resolve 是内容端点，blob 与 src 是网页端点 */
const RAW_ANCHOR_SEGMENTS = new Set(['raw', 'resolve', 'blob', 'src']);
/** 锚点前后可出现的无信息段（跳过即可，不影响 owner/repo 的定位） */
const RAW_SKIP_SEGMENTS = new Set(['-', 'branch']);

/**
 * raw CDN 域名：/{owner}/{repo}/{branch}/{path} 形态（没有锚点段），batch 端点挂在对应主站。
 * 新平台出现这类域名时在此补一行映射。
 */
const RAW_CDN_ORIGINS: Record<string, string> = {
    'raw.githubusercontent.com': 'https://github.com',
    'raw.github.com': 'https://github.com',
    'raw.gitcode.com': 'https://gitcode.com',
    'raw.gitee.com': 'https://gitee.com'
};

/** 从 raw/blob 直链里解析出的仓库定位信息 */
export interface GitHostUrlInfo {
    /** 平台主站 origin：LFS batch 端点挂在这里 */
    origin: string;
    owner: string;
    /** 仓库名（不含 .git 后缀） */
    repo: string;
    /** 锚点段：raw / resolve 是内容端点，blob / src 是网页 */
    anchor: string;
}

function stripGitSuffix(repo: string): string {
    return repo.replace(/\.git$/i, '');
}

/**
 * 在 pathname 分段里定位锚点段：锚点只允许出现在 owner/repo（前两段）之后，
 * 其前可夹 RAW_SKIP_SEGMENTS 里的无信息段。不是锚点形态时返回 -1。
 */
function findAnchorSegmentIndex(segments: string[]): number {
    let index = 2;
    while (index < segments.length && RAW_SKIP_SEGMENTS.has(segments[index])) index += 1;
    return index < segments.length && RAW_ANCHOR_SEGMENTS.has(segments[index]) ? index : -1;
}

/**
 * 解析一段 git 托管平台的 raw/blob 直链，定位仓库（owner/repo/origin）与锚点段。
 *
 * 不是 git 托管形态（缺少 owner/repo 两段前缀或没有锚点段）时返回 null。
 */
export function describeGitHostUrl(downloadUrl: string): GitHostUrlInfo | null {
    const value = downloadUrl.trim();
    if (!value) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    // GitCode api 前缀形态：/{api}/v5/repos/{owner}/{repo}/…
    if (segments.length >= 5 && segments[0] === 'api' && segments[1] === 'v5' && segments[2] === 'repos') {
        return { origin: url.origin, owner: segments[3], repo: stripGitSuffix(segments[4]), anchor: 'raw' };
    }
    // raw CDN 域名形态：/{owner}/{repo}/{branch}/{path…}（分支名带斜杠时无法与路径区分，
    // 按单段分支处理；这里只需要 owner/repo，分支段不参与推导）
    const cdnOrigin = RAW_CDN_ORIGINS[url.host.toLowerCase()];
    if (cdnOrigin) {
        if (segments.length < 3) return null;
        return { origin: cdnOrigin, owner: segments[0], repo: stripGitSuffix(segments[1]), anchor: 'raw' };
    }
    // 通用锚点形态：/{owner}/{repo}/[skip…]{raw|blob|src|resolve}/…
    const anchorIndex = findAnchorSegmentIndex(segments);
    if (anchorIndex < 0) return null;
    return { origin: url.origin, owner: segments[0], repo: stripGitSuffix(segments[1]), anchor: segments[anchorIndex] };
}

/**
 * 下载地址归一入口：把 git 托管平台的网页/预览形态统一成「能拿到文件内容（或 pointer）」的直链。
 * 非 git 托管形态原样返回。
 *
 * 规则：
 * - GitCode raw.gitcode.com 预览端点对 LFS 二进制 403 → 等价换成 api/v5 raw 端点；
 * - blob / src 网页锚点 → 同平台同分支的 raw 直链锚点（GitLab 的 '-'、Gitea 的 branch
 *   字面段保持原位）；GitHub 的 github.com/{o}/{r}/raw/… 会 302 到 media 端点直接给真身。
 */
export function normalizeGitDownloadUrl(downloadUrl: string): string {
    const value = downloadUrl.trim();
    // GitCode 预览域名的 403 是行为级差异，必须换端点；其余平台走通用的锚点替换
    const gitcodeNormalized = normalizeGitCodeRawUrl(value);
    if (gitcodeNormalized !== value) return gitcodeNormalized;

    let url: URL;
    try {
        url = new URL(gitcodeNormalized);
    } catch {
        return gitcodeNormalized;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return gitcodeNormalized;
    // 只把「锚点位置」的 blob/src 换成 raw；路径更深处的同名目录（src/ 极常见）不是
    // 锚点，必须原样保留。pathname 是编码形态，未触及时原样拼接
    const parts = url.pathname.split('/').filter((segment) => segment.length > 0);
    const anchorIndex = findAnchorSegmentIndex(parts);
    if (anchorIndex < 0 || (parts[anchorIndex] !== 'blob' && parts[anchorIndex] !== 'src')) {
        return gitcodeNormalized;
    }
    parts[anchorIndex] = 'raw';
    return url.origin + '/' + parts.join('/') + url.search;
}

/**
 * 从下载地址推导该仓库的 LFS batch 端点（Git LFS 标准约定：
 * git 远端地址 + `/info/lfs/objects/batch`）。不是 git 托管形态的地址返回 null。
 */
export function resolveLfsBatchUrl(downloadUrl: string): string | null {
    const info = describeGitHostUrl(downloadUrl);
    if (!info) return null;
    return formatBatchUrl(info.origin, info.owner, info.repo);
}

export interface LfsDownloadHref {
    href: string;
    headers: Record<string, string>;
}

/** 按 batch 端点响应解出真实下载地址；请求头（如鉴权）随 href 一并带回 */
export async function resolveLfsDownloadHref(
    batchUrl: string,
    pointer: LfsPointer,
    fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
    timeoutMs: number = LFS_BATCH_TIMEOUT_MS
): Promise<LfsDownloadHref> {
    let response: Response;
    try {
        response = await fetchImpl(batchUrl, {
            method: 'POST',
            headers: {
                accept: 'application/vnd.git-lfs+json',
                'content-type': 'application/vnd.git-lfs+json'
            },
            body: JSON.stringify({
                operation: 'download',
                transfer: ['basic'],
                hashes: ['sha256'],
                objects: [{ oid: pointer.oid, size: pointer.size }]
            }),
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        throw new LfsResolveError(toErrorMessage(error));
    }
    if (!response.ok) {
        // 取消未消费的响应体，连接立刻回到连接池
        await response.body?.cancel().catch(() => undefined);
        throw new LfsResolveError(`HTTP ${response.status}`);
    }
    let payload: LfsBatchResponse;
    try {
        payload = (await response.json()) as LfsBatchResponse;
    } catch (error) {
        throw new LfsResolveError(toErrorMessage(error));
    }
    const object = payload.objects?.[0];
    // batch 端点按对象粒度报错（如 Object does not exist）：透出服务端消息便于定位
    if (object?.error && typeof object.error.message === 'string') {
        throw new LfsResolveError(object.error.message);
    }
    const action = object?.actions?.download;
    const href = typeof action?.href === 'string' ? action.href : '';
    if (!action || !href) {
        throw new LfsResolveError('no download href in batch response');
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(action.header ?? {})) {
        if (typeof value === 'string') headers[key] = value;
    }
    return { href, headers };
}

interface LfsBatchResponse {
    objects?: Array<{
        error?: {
            message?: unknown;
        };
        actions?: {
            download?: {
                href?: unknown;
                header?: unknown;
            };
        };
    }>;
}

export interface ResolvedLfsResponse {
    /** 最终响应：未命中 pointer 时就是传入的响应，命中时是解引用后的重下载 */
    response: Response;
    /**
     * 完整内容流：pointer 检测 peek 过的字节已拼回流的开头，调用方直接消费。
     * 响应本体没有 body 时为 null，调用方走 `response.arrayBuffer()` 兜底。
     */
    stream: ReadableStream<Uint8Array> | null;
}

/**
 * 对一个已发起的下载响应做 Git LFS 处理（benchmark 与 pluginmgr 共用）：
 * 响应是指针文本时按 batch 协议解引用成 CDN 直链重新下载，普通文件原样放行。
 *
 * 调用方先完成首响应的 ok 检查；重下载失败与解引用失败统一抛 `LfsResolveError`，
 * 由调用方包装成本地文案 / 错误码。
 */
export async function resolveResponseLfs(
    response: Response,
    requestUrl: string,
    fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
    /** 重下载时使用的请求参数；headers 会并入 batch 响应要求的头 */
    refetchInit: RequestInit & { headers?: Record<string, string> } = {}
): Promise<ResolvedLfsResponse> {
    const check = await takeLfsPointer(response);
    if (!check.pointer) {
        return { response, stream: check.stream };
    }
    const batchUrl = resolveLfsBatchUrl(requestUrl);
    if (!batchUrl) throw new LfsResolveError('not a git host URL');
    const resolved = await resolveLfsDownloadHref(batchUrl, check.pointer, fetchImpl);
    const redownloaded = await fetchImpl(resolved.href, {
        ...refetchInit,
        headers: { ...refetchInit.headers, ...resolved.headers }
    });
    if (!redownloaded.ok) {
        // 取消未消费的响应体，连接立刻回到连接池
        await redownloaded.body?.cancel().catch(() => undefined);
        throw new LfsResolveError(`HTTP ${redownloaded.status}`);
    }
    return { response: redownloaded, stream: redownloaded.body };
}

function formatBatchUrl(origin: string, owner: string, repo: string): string | null {
    // owner/repo 来自 describeGitHostUrl（已剥 .git 后缀且非空段），这里只兜 strip 后为空的病态仓库名
    if (!owner || !repo) return null;
    return `${origin}/${owner}/${repo}.git/info/lfs/objects/batch`;
}

/** 把 peek 出来的字节 + 未读完的流拼回一个完整流 */
function streamFromParts(prefix: Buffer, rest: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            if (prefix.length > 0) controller.enqueue(new Uint8Array(prefix));
        },
        // pull 按需拉取：归档包几十兆，无背压的预读会把整个响应体排进队列占用内存，
        // 消费节奏必须交给下游
        async pull(controller) {
            try {
                const { done, value } = await rest.read();
                if (done) controller.close();
                else controller.enqueue(value);
            } catch (error) {
                // 调用方 cancel 之后 enqueue/close/error 都会因流已关闭而抛（那是正常退出
                // 路径，必须吞掉，否则变成 unhandled rejection）；流还开着时 error() 生效
                try {
                    controller.error(error);
                } catch {
                    /* 包装流已关闭，忽略 */
                }
            }
        },
        // 下载失败中止（benchmark 看门狗销毁流、pluginmgr pipeline 出错）要传到底层 reader：
        // 不 cancel 的话 fetch 连接挂着，直到 GC 才释放
        cancel() {
            return rest.cancel();
        }
    });
}
