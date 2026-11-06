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
 * 技能安装管理：SkillInstallManager 负责安装入口路由、注册表搜索匹配与卸载；
 * SkillSourceInstaller 抽象基类封装统一安装流程（解析 → 校验 → 落盘 → 冲突处理 → 刷新），
 * 各子类只负责"将安装源解析为本地技能目录"，冲突策略在构造时注入。
 * 通过此类安装的技能均为用户安装技能（落盘到 apps/skills/resources）。
 */

import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { getTempDir } from '../../../utils/temp.js';
import { logger } from '../../../utils/logger.js';
import { toErrorMessage } from '../../../../common/utils/error.js';
import { getPlatform } from '../../../../platforms/base.js';
import {
    allRegistries,
    ensureSkillRegistriesSynced,
    getRegistry,
    getRegistriesInfo as getRegistryInfoList,
    searchRegistry as searchSingleRegistry,
    getInstallMethod,
    parseInstallUrl,
    type RegistrySkill,
    type SearchOptions
} from '../registry/index.js';
import type { ContributedSkillRegistry } from '../registry/contributed.js';
import { findSkillEntryFile, CANONICAL_SKILL_FILENAME } from '../skill-entry.js';
import { SkillRegistry } from './skill-registry.js';

const CLAWHUB_API_BASE = 'https://wry-manatee-359.convex.site/api/v1';
const CLAWHUB_DOWNLOAD_URL = `${CLAWHUB_API_BASE}/download`;
const CLAWHUB_SEARCH_URL = `${CLAWHUB_API_BASE}/search`;
const SKILLHUB_DOWNLOAD_URL = 'https://api.skillhub.tencent.com/api/v1/download';
const ZIP_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const GITHUB_ZIP_TIMEOUT_MS = 60000;

export const CLAWHUB_INSTALL_PREFIX = 'clawhub:';
export const MATRIX_INSTALL_PREFIX = 'matrix:';
export const MODELSCOPE_INSTALL_PREFIX = 'modelscope:';
export const SKILLHUB_INSTALL_PREFIX = 'skillhub:';

// ── 冲突策略 ─────────────────────────────────────────────────────────────

export type SkillInstallConflictPolicy =
    { action: 'auto-rename' } | { action: 'reject' } | { action: 'overwrite' } | { action: 'rename'; name: string };

const AUTO_RENAME_CONFLICT: SkillInstallConflictPolicy = { action: 'auto-rename' };
const REJECT_CONFLICT: SkillInstallConflictPolicy = { action: 'reject' };

export interface InstallSkillResult {
    success: boolean;
    name?: string;
    error?: string;
}

export interface RegistrySearchSkill {
    fullName: string;
    skillName: string;
    skillId: string;
    registryName: string;
    registryLabel: string;
    description: string;
    installUrl?: string;
    author?: string;
    installCount: number;
    downloads?: number;
    stars?: number;
    score?: number;
    canInstall: boolean;
}

export interface RegistrySearchResult {
    results: RegistrySearchSkill[];
    errors: Array<{ registryName: string; error: string }>;
}

export interface RegistryInstallOptions {
    force?: boolean;
    skillsmpApiKey?: string;
    install?: (installUrl: string, force: boolean) => Promise<InstallSkillResult>;
    skillExists?: (skillName: string) => boolean;
}

function isSkillConflictError(result: InstallSkillResult): boolean {
    return !result.success && /^技能「.+?」已存在(?:，.*)?$/.test(result.error || '');
}

function validateCustomSkillName(name: string): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) return '技能名称不能为空';
    if (trimmed.length > 64) return '技能名称长度不能超过 64 个字符';
    if (trimmed === '.' || trimmed === '..' || /[/\\\x00-\x1f\x7f]/.test(trimmed) || path.isAbsolute(trimmed)) {
        return '技能名称不能包含路径分隔符或控制字符';
    }
    return undefined;
}

// ── 文件工具 ─────────────────────────────────────────────────────────────

/** 递归复制目录 */
function copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name);
        const d = path.join(dest, ent.name);
        if (ent.isDirectory()) copyDirRecursive(s, d);
        else fs.copyFileSync(s, d);
    }
}

/** existsSync 会把悬空链接当作不存在；lstat 让它仍占用技能名称。 */
function pathEntryExists(p: string): boolean {
    try {
        fs.lstatSync(p);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code !== 'ENOENT';
    }
}

/** 递归删除目录或文件；优先使用 fs.rmSync 以兼容鸿蒙 HarmonyOS */
function rmRecursive(p: string): void {
    try {
        if (typeof fs.rmSync === 'function') {
            fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            return;
        }
    } catch {
        // fall back to manual recursive cleanup
    }
    try {
        const stat = fs.lstatSync(p);
        // 降级清理时 stat 会跟随目录链接；lstat 保证只删除链接，不递归删除目标。
        if (stat.isSymbolicLink()) {
            fs.unlinkSync(p);
        } else if (stat.isDirectory()) {
            for (const name of fs.readdirSync(p)) rmRecursive(path.join(p, name));
            fs.rmdirSync(p);
        } else {
            fs.unlinkSync(p);
        }
    } catch {
        // ignore cleanup failures
    }
}

function getZipUncompressedSize(zip: AdmZip): { total: number; error?: string } {
    const entries = zip.getEntries();
    let total = 0;
    for (const e of entries) {
        if (e.isDirectory) continue;
        const size = e.header && typeof e.header.size === 'number' ? e.header.size : null;
        if (size == null || size < 0) {
            return { total: 0, error: '压缩包包含无法解析体积的条目，拒绝解压' };
        }
        total += size;
        if (total > ZIP_MAX_UNCOMPRESSED_BYTES) {
            return {
                total,
                error: `解压后体积超过限制（${(ZIP_MAX_UNCOMPRESSED_BYTES / 1024 / 1024).toFixed(0)}MB），当前约 ${(total / 1024 / 1024).toFixed(1)}MB`
            };
        }
    }
    return { total };
}

function findSkillRootInDir(rootDir: string, relPath?: string | null): string | null {
    if (findSkillEntryFile(rootDir)) {
        return rootDir;
    }

    if (relPath && typeof relPath === 'string') {
        const parts = relPath.split('/').filter(Boolean);
        if (parts.length > 0) {
            const candidate = path.join(rootDir, ...parts);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                if (findSkillEntryFile(candidate)) return candidate;
            }
        }
    }

    try {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const sub = path.join(rootDir, e.name);
            const found = findSkillRootInDir(sub, null);
            if (found) return found;
        }
    } catch {
        // ignore
    }
    return null;
}

/**
 * 解压 zip 并定位技能根目录（含 SKILL.md 的目录）。
 * 解压发生在临时目录，返回的 cleanup 用于安装完成后清理。
 */
function extractZipToSkillDir(zipPath: string, skillRelPath?: string): { skillRoot: string; cleanup: () => void } {
    // mkdtempSync 保证跨进程原子唯一：多个 Jest worker / 并发安装共享同一临时根目录，
    // Date.now() 命名会在同一毫秒撞名，导致两个压缩包解进同一目录、技能根目录解析错乱
    const tmpDir = fs.mkdtempSync(path.join(getTempDir(), 'skill-zip-'));
    const safeRelPath = skillRelPath && typeof skillRelPath === 'string' ? skillRelPath.trim() : '';

    try {
        const zip = new AdmZip(zipPath);
        const sizeResult = getZipUncompressedSize(zip);
        if (sizeResult.error) throw new Error(sizeResult.error);

        zip.extractAllTo(tmpDir, true);
        const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
        const extractRoot =
            entries.length === 1 && entries[0].isDirectory() ? path.join(tmpDir, entries[0].name) : tmpDir;
        const skillRoot = safeRelPath
            ? findSkillRootInDir(extractRoot, safeRelPath)
            : findSkillRootInDir(extractRoot, null);
        if (!skillRoot) {
            throw new Error('压缩包内未找到含 SKILL.md 的技能目录');
        }
        return { skillRoot, cleanup: () => rmRecursive(tmpDir) };
    } catch (e) {
        rmRecursive(tmpDir);
        throw e;
    }
}

// ── GitHub URL 工具 ──────────────────────────────────────────────────────

function parseGitHubTreeUrl(githubUrl: string): { owner: string; repo: string; branch: string; path: string } | null {
    if (!githubUrl || typeof githubUrl !== 'string') return null;
    const url = githubUrl.trim();
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*?))?(?:\?.*)?$/i);
    if (!m) return null;
    const [, owner, repo, branch, relPath] = m;
    const pathPart = (relPath || '').replace(/\/+$/, '');
    if (!owner || !repo || !branch) return null;
    return { owner, repo, branch, path: pathPart };
}

async function fetchGitHubZipWithFallback(zipUrl: string): Promise<Response> {
    const opts = () => ({ redirect: 'follow' as const, signal: AbortSignal.timeout(GITHUB_ZIP_TIMEOUT_MS) });
    try {
        return await getPlatform().fetch(zipUrl, opts());
    } catch (e: any) {
        const msg = e?.message || String(e);
        if (
            msg.includes('fetch failed') ||
            msg.includes('ECONNREFUSED') ||
            msg.includes('ENOTFOUND') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('network')
        ) {
            const mirrorUrl = `https://ghproxy.com/${zipUrl}`;
            try {
                return await getPlatform().fetch(mirrorUrl, opts());
            } catch (e2: any) {
                throw new Error(`直连与镜像均失败。直连: ${msg}；镜像: ${e2?.message || e2}`);
            }
        }
        throw e;
    }
}

// ── SkillSourceInstaller 基类与子类 ──────────────────────────────────────

/**
 * 技能安装源抽象基类：统一安装流程为模板方法（install），
 * 子类只需实现 resolveToLocalDir 将安装源解析为本地技能目录。
 * 冲突策略在构造时注入（未注入时使用子类默认策略）。
 */
export abstract class SkillSourceInstaller {
    protected readonly registry: SkillRegistry;
    protected readonly conflictPolicy: SkillInstallConflictPolicy;

    constructor(options: { registry: SkillRegistry; conflictPolicy?: SkillInstallConflictPolicy }) {
        this.registry = options.registry;
        this.conflictPolicy = options.conflictPolicy ?? this.defaultConflictPolicy();
    }

    /** 子类默认冲突策略（未在构造时注入时生效） */
    protected abstract defaultConflictPolicy(): SkillInstallConflictPolicy;

    /**
     * 子类实现：将安装源解析为本地技能目录（含 SKILL.md 的目录）。
     * @param cleanup 用于注册临时目录清理函数，安装流程结束后统一执行
     */
    protected abstract resolveToLocalDir(cleanup: Array<() => void>): string | Promise<string>;

    /** 统一安装流程：解析 → 校验 → 落盘（冲突处理）→ 刷新 */
    async install(options: { refresh?: boolean; fallbackName?: string } = {}): Promise<InstallSkillResult> {
        const cleanup: Array<() => void> = [];
        try {
            const skillDir = await this.resolveToLocalDir(cleanup);
            return this._installFromLocalDir(skillDir, options);
        } catch (e: any) {
            return { success: false, error: e?.message || '安装失败' };
        } finally {
            for (const fn of cleanup) fn();
        }
    }

    /** 统一落盘流程：校验 SKILL.md → 冲突处理 → 复制落盘 → 刷新缓存 */
    protected _installFromLocalDir(
        skillDir: string,
        options: { refresh?: boolean; fallbackName?: string }
    ): InstallSkillResult {
        const refresh = options.refresh ?? true;
        const resolved = path.resolve(skillDir);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            return { success: false, error: '源路径不存在或不是目录' };
        }
        const result = this.registry._loadSkillFromDir(resolved, options.fallbackName);
        if (!result.success) return { success: false, error: result.error };
        const skillsDir = path.resolve(this.registry.getSkillsDirectory());
        const originalName = result.name!;
        let targetName = originalName;

        if (this.conflictPolicy.action === 'rename') {
            const validationError = validateCustomSkillName(this.conflictPolicy.name);
            if (validationError) return { success: false, error: validationError };
            targetName = this.conflictPolicy.name.trim();
        }

        let destDir = path.resolve(skillsDir, targetName);
        const relativeDest = path.relative(skillsDir, destDir);
        if (!relativeDest || relativeDest.startsWith('..') || path.isAbsolute(relativeDest)) {
            return { success: false, error: '无效的技能名称' };
        }

        if (pathEntryExists(destDir)) {
            if (this.conflictPolicy.action === 'overwrite') {
                try {
                    // 覆盖链接时只移除链接，外部技能目录保持原样。
                    if (fs.lstatSync(destDir).isSymbolicLink()) {
                        fs.unlinkSync(destDir);
                    } else if (typeof fs.rmSync === 'function') {
                        fs.rmSync(destDir, { recursive: true, force: true });
                    } else {
                        rmRecursive(destDir);
                    }
                } catch (e) {
                    return { success: false, error: `删除旧技能失败: ${toErrorMessage(e)}` };
                }
            } else if (this.conflictPolicy.action === 'auto-rename') {
                let counter = 1;
                do {
                    targetName = `${originalName}-${counter}`;
                    counter++;
                } while (pathEntryExists(path.join(skillsDir, targetName)));
                destDir = path.join(skillsDir, targetName);
                logger.info(`SkillInstaller: 技能名冲突，自动重命名为 ${targetName}`);
            } else {
                return { success: false, error: `技能「${targetName}」已存在` };
            }
        }
        result.name = targetName;
        let createdDestination = false;
        try {
            // 仅在本次安装创建目录后清理复制失败的残留，避免删除已有路径。
            fs.mkdirSync(destDir);
            createdDestination = true;
            copyDirRecursive(resolved, destDir);
            // 从 metadata.json 合成的技能需要落盘 SKILL.md
            if (result._synthesized && result._synthesizedMd) {
                fs.writeFileSync(path.join(destDir, CANONICAL_SKILL_FILENAME), result._synthesizedMd, 'utf8');
            }
            const installedSkillMdPath = findSkillEntryFile(destDir);
            if (installedSkillMdPath && path.basename(installedSkillMdPath) !== CANONICAL_SKILL_FILENAME) {
                fs.renameSync(installedSkillMdPath, path.join(destDir, CANONICAL_SKILL_FILENAME));
            }
            // 自动重命名后同步更新 SKILL.md 内的 name 字段，确保目录名与缓存 key 一致
            if (result.name !== originalName) {
                const skillMdPath = findSkillEntryFile(destDir);
                if (skillMdPath && fs.existsSync(skillMdPath)) {
                    try {
                        let content = fs.readFileSync(skillMdPath, 'utf8');
                        content = content.replace(/^name:\s*.+$/m, `name: ${result.name}`);
                        fs.writeFileSync(skillMdPath, content, 'utf8');
                    } catch (e) {
                        logger.warn(`SkillInstaller: 更新 SKILL.md name 失败: ${toErrorMessage(e)}`);
                    }
                }
            }
            if (refresh) {
                this.registry.refresh(); // 全量刷新缓存与 toolset
            }
            return { success: true, name: result.name };
        } catch (e) {
            if (createdDestination) rmRecursive(destDir);
            return { success: false, error: `复制失败: ${toErrorMessage(e)}` };
        }
    }

    /** 模块私有：下载 zip 到临时目录并解压出技能根目录 */
    protected async _downloadAndExtractZip(url: string, label: string, cleanup: Array<() => void>): Promise<string> {
        const res = await getPlatform().fetch(url, { redirect: 'follow' });
        if (!res.ok) {
            throw new Error(`下载失败: ${res.status} ${res.statusText}`);
        }
        const zipBuffer = Buffer.from(await res.arrayBuffer());
        return this._writeAndExtractZip(zipBuffer, label, cleanup);
    }

    /** 将 zip 字节流写入临时目录并解压出技能根目录 */
    protected async _writeAndExtractZip(zipBuffer: Buffer, label: string, cleanup: Array<() => void>): Promise<string> {
        // mkdtempSync 保证跨进程原子唯一：多个 Jest worker / 并发安装共享同一临时根目录，
        // Date.now() 命名会在同一毫秒撞名，导致两个压缩包解进同一目录、技能根目录解析错乱
        const tmpDir = fs.mkdtempSync(path.join(getTempDir(), `${label}-`));
        cleanup.push(() => rmRecursive(tmpDir));
        const zipPath = path.join(tmpDir, 'download.zip');
        fs.writeFileSync(zipPath, zipBuffer);
        const extracted = extractZipToSkillDir(zipPath, undefined);
        cleanup.push(extracted.cleanup);
        return extracted.skillRoot;
    }
}

/** 从本地目录安装（目录须含 SKILL.md，目录名可与 name 不一致，以 frontmatter name 为准） */
export class LocalDirectoryInstaller extends SkillSourceInstaller {
    private readonly sourceDir: string;

    constructor(options: { registry: SkillRegistry; sourceDir: string; conflictPolicy?: SkillInstallConflictPolicy }) {
        super({ registry: options.registry, conflictPolicy: options.conflictPolicy });
        this.sourceDir = options.sourceDir;
    }

    protected defaultConflictPolicy(): SkillInstallConflictPolicy {
        return AUTO_RENAME_CONFLICT;
    }

    protected resolveToLocalDir(_cleanup: Array<() => void>): string {
        return this.sourceDir;
    }
}

/** 从本地 zip 文件安装 */
export class LocalZipInstaller extends SkillSourceInstaller {
    private readonly zipPath: string;
    private readonly skillRelPath?: string;

    constructor(options: {
        registry: SkillRegistry;
        zipPath: string;
        skillRelPath?: string;
        conflictPolicy?: SkillInstallConflictPolicy;
    }) {
        super({ registry: options.registry, conflictPolicy: options.conflictPolicy });
        if (!options.zipPath || typeof options.zipPath !== 'string') {
            throw new Error('请选择有效的 zip 文件');
        }
        this.zipPath = options.zipPath;
        this.skillRelPath = options.skillRelPath;
    }

    protected defaultConflictPolicy(): SkillInstallConflictPolicy {
        return AUTO_RENAME_CONFLICT;
    }

    protected resolveToLocalDir(cleanup: Array<() => void>): string {
        const resolved = path.resolve(this.zipPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            throw new Error('文件不存在或不是文件');
        }
        if (path.extname(resolved).toLowerCase() !== '.zip') {
            throw new Error('请选择 .zip 格式的压缩包');
        }
        const extracted = extractZipToSkillDir(resolved, this.skillRelPath);
        cleanup.push(extracted.cleanup);
        return extracted.skillRoot;
    }
}

/** 从 http(s) URL 下载 zip 并安装 */
export class HttpUrlInstaller extends SkillSourceInstaller {
    private readonly url: string;

    constructor(options: { registry: SkillRegistry; url: string; conflictPolicy?: SkillInstallConflictPolicy }) {
        super({ registry: options.registry, conflictPolicy: options.conflictPolicy });
        if (!options.url || typeof options.url !== 'string') {
            throw new Error('请提供有效的 URL');
        }
        this.url = options.url;
    }

    protected defaultConflictPolicy(): SkillInstallConflictPolicy {
        return REJECT_CONFLICT;
    }

    protected async resolveToLocalDir(cleanup: Array<() => void>): Promise<string> {
        const trimmed = this.url.trim();
        if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            throw new Error('URL 须以 http:// 或 https:// 开头');
        }
        return this._downloadAndExtractZip(trimmed, 'skill-download', cleanup);
    }
}

/** 从 GitHub 仓库/tree URL 安装（支持镜像回退） */
export class GitHubUrlInstaller extends SkillSourceInstaller {
    private readonly url: string;

    constructor(options: { registry: SkillRegistry; url: string; conflictPolicy?: SkillInstallConflictPolicy }) {
        super({ registry: options.registry, conflictPolicy: options.conflictPolicy });
        this.url = options.url;
    }

    protected defaultConflictPolicy(): SkillInstallConflictPolicy {
        return REJECT_CONFLICT;
    }

    protected async resolveToLocalDir(cleanup: Array<() => void>): Promise<string> {
        let parsed = parseGitHubTreeUrl(this.url);
        if (!parsed) {
            const repoMatch = this.url.trim().match(/github\.com\/([^/]+)\/([^/?#]+)/i);
            if (repoMatch) {
                parsed = { owner: repoMatch[1], repo: repoMatch[2].replace(/\.git$/, ''), branch: 'main', path: '' };
            }
        }
        if (!parsed) {
            throw new Error('无效的 GitHub 技能 URL');
        }
        const { owner, repo, branch, path: relPath } = parsed;

        const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
        const tmpDir = fs.mkdtempSync(path.join(getTempDir(), 'skill-registry-github-'));
        cleanup.push(() => rmRecursive(tmpDir));

        const res = await fetchGitHubZipWithFallback(zipUrl);
        if (!res.ok) {
            throw new Error(`下载失败: ${res.status} ${res.statusText}`);
        }
        const zipBuffer = Buffer.from(await res.arrayBuffer());
        const zipPath = path.join(tmpDir, 'repo.zip');
        fs.writeFileSync(zipPath, zipBuffer);
        const extracted = extractZipToSkillDir(zipPath, relPath || undefined);
        cleanup.push(extracted.cleanup);
        return extracted.skillRoot;
    }
}

const REGISTRY_SLUG_ERRORS: Record<string, string> = {
    clawhub: '请提供 ClawHub 技能 slug（如 my-skill 或 owner/my-skill）',
    matrix: '请提供 Matrix Skill 的英文名称（如 test-master）',
    skillhub: '请提供 SkillHub 技能 slug',
    modelscope: '请提供 ModelScope 技能名称'
};

/** 从注册表 slug 安装（clawhub/matrix/skillhub/modelscope 各自的下载 URL 构造） */
export class RegistrySlugInstaller extends SkillSourceInstaller {
    private readonly registryId: string;
    private readonly slug: string;
    private readonly version?: string;

    constructor(options: {
        registry: SkillRegistry;
        registryId: string;
        slug: string;
        version?: string;
        conflictPolicy?: SkillInstallConflictPolicy;
    }) {
        super({ registry: options.registry, conflictPolicy: options.conflictPolicy });
        const slug = String(options.slug || '').trim();
        if (!slug) {
            throw new Error(REGISTRY_SLUG_ERRORS[options.registryId] ?? '请提供技能 slug');
        }
        this.registryId = options.registryId;
        this.slug = slug;
        this.version = options.version;
    }

    protected defaultConflictPolicy(): SkillInstallConflictPolicy {
        return REJECT_CONFLICT;
    }

    protected async resolveToLocalDir(cleanup: Array<() => void>): Promise<string> {
        if (this.registryId === 'clawhub') {
            return this._downloadClawHubZip(cleanup);
        }
        return this._downloadAndExtractZip(this._buildDownloadUrl(), `skill-${this.registryId}-download`, cleanup);
    }

    /** 拆分 clawhub 的 owner/slug 复合 slug（裸 slug 时 ownerHandle 为空） */
    private _splitClawHubSlug(): { ownerHandle?: string; slug: string } {
        const separatorIndex = this.slug.indexOf('/');
        if (separatorIndex <= 0) return { slug: this.slug };
        return { ownerHandle: this.slug.slice(0, separatorIndex), slug: this.slug.slice(separatorIndex + 1) };
    }

    private _buildClawHubDownloadUrl(ownerHandle: string | undefined, slug: string): string {
        const params = new URLSearchParams({ slug });
        if (ownerHandle) {
            params.set('ownerHandle', ownerHandle);
        }
        if (this.version && String(this.version).trim()) {
            params.set('version', String(this.version).trim());
        }
        return `${CLAWHUB_DOWNLOAD_URL}?${params}`;
    }

    /**
     * ClawHub 下载：slug 允许被多个发布者占用，裸 slug 撞名时服务端返回 409，
     * 此时经搜索接口解析唯一 ownerHandle 后重试；无法唯一解析则报错并保留服务端原因。
     */
    private async _downloadClawHubZip(cleanup: Array<() => void>): Promise<string> {
        const label = 'skill-clawhub-download';
        const { ownerHandle, slug } = this._splitClawHubSlug();
        const res = await getPlatform().fetch(this._buildClawHubDownloadUrl(ownerHandle, slug), {
            redirect: 'follow'
        });
        if (res.status !== 409 || ownerHandle) {
            if (!res.ok) {
                throw new Error(`下载失败: ${res.status} ${res.statusText}`);
            }
            return this._writeAndExtractZip(Buffer.from(await res.arrayBuffer()), label, cleanup);
        }
        const ambiguousMessage = await res.text().catch(() => '');
        const resolvedOwner = await this._resolveClawHubOwnerBySearch(slug);
        if (!resolvedOwner) {
            throw new Error(
                `下载失败: 409 Conflict，ClawHub slug「${slug}」被多个发布者占用且无法唯一解析发布者` +
                    (ambiguousMessage.trim() ? `: ${ambiguousMessage.trim()}` : '')
            );
        }
        const retryRes = await getPlatform().fetch(this._buildClawHubDownloadUrl(resolvedOwner, slug), {
            redirect: 'follow'
        });
        if (!retryRes.ok) {
            throw new Error(`下载失败: ${retryRes.status} ${retryRes.statusText}`);
        }
        return this._writeAndExtractZip(Buffer.from(await retryRes.arrayBuffer()), label, cleanup);
    }

    /** 裸 slug 撞名时经搜索接口解析唯一 ownerHandle；0 个或多个候选均视为无法唯一解析 */
    private async _resolveClawHubOwnerBySearch(slug: string): Promise<string | undefined> {
        try {
            const params = new URLSearchParams({ q: slug, limit: '100' });
            const res = await getPlatform().fetch(`${CLAWHUB_SEARCH_URL}?${params}`, {
                headers: { Accept: 'application/json', 'User-Agent': 'OpenDesk/1.0' },
                redirect: 'follow'
            });
            if (!res.ok) return undefined;
            const data = await res.json();
            const results = Array.isArray(data?.results) ? data.results : [];
            const ownerHandles = new Set<string>();
            for (const item of results) {
                if (item?.slug !== slug) continue;
                if (typeof item?.ownerHandle === 'string' && item.ownerHandle) ownerHandles.add(item.ownerHandle);
            }
            return ownerHandles.size === 1 ? ownerHandles.values().next().value : undefined;
        } catch {
            return undefined;
        }
    }

    private _buildDownloadUrl(): string {
        if (this.registryId === 'clawhub') {
            const { ownerHandle, slug } = this._splitClawHubSlug();
            return this._buildClawHubDownloadUrl(ownerHandle, slug);
        }
        if (this.registryId === 'matrix') {
            return `https://matrix.openharmony.cn/api/registry/skill/${encodeURIComponent(this.slug)}/install?format=zip`;
        }
        if (this.registryId === 'skillhub') {
            return `${SKILLHUB_DOWNLOAD_URL}?slug=${encodeURIComponent(this.slug)}`;
        }
        if (this.registryId === 'modelscope') {
            return `https://www.modelscope.cn/api/v1/skills/${this.slug}/archive/zip/master`;
        }
        throw new Error(`未知 Registry: ${this.registryId}`);
    }
}

// ── 注册表搜索辅助（模块私有） ───────────────────────────────────────────

function normalizeRegistryName(registryName: string): import('../registry/index.js').SkillRegistryBase | undefined {
    const expected = String(registryName || '')
        .trim()
        .toLowerCase();
    return allRegistries.find(
        (registry) => registry.id.toLowerCase() === expected || registry.label.toLowerCase() === expected
    );
}

function normalizeRegistryToken(value: string): string {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function getRegistrySkillFullName(
    registry: import('../registry/index.js').SkillRegistryBase,
    skill: RegistrySkill
): string {
    return `${registry.id}/${skill.name || skill.id || ''}`;
}

function mapRegistrySkill(
    registry: import('../registry/index.js').SkillRegistryBase,
    skill: RegistrySkill
): RegistrySearchSkill {
    const skillName = String(skill.name || skill.id || '');
    const skillId = String(skill.id || skill.name || '');
    const installCount = Number(skill.downloads ?? 0) || 0;
    return {
        fullName: `${registry.id}/${skillName}`,
        skillName,
        skillId,
        registryName: registry.id,
        registryLabel: registry.label,
        description: String(skill.description || ''),
        installUrl: skill.installUrl || undefined,
        author: skill.author || undefined,
        installCount,
        downloads: skill.downloads,
        stars: skill.stars,
        score: skill.score,
        canInstall: !!skill.canInstall
    };
}

function normalizeRequestedRegistrySkillName(
    registry: import('../registry/index.js').SkillRegistryBase,
    skillName: string
): { query: string; error?: string } {
    const raw = String(skillName || '').trim();
    const slash = raw.indexOf('/');
    if (slash <= 0) {
        return { query: raw };
    }

    const prefix = raw.slice(0, slash);
    const prefixedRegistry = normalizeRegistryName(prefix);
    if (!prefixedRegistry) {
        return { query: raw };
    }
    if (prefixedRegistry.id !== registry.id) {
        return {
            query: raw,
            error: `技能全名 ${raw} 属于 ${prefixedRegistry.id}，但请求安装的 Registry 是 ${registry.id}`
        };
    }
    return { query: raw.slice(slash + 1).trim() };
}

function isExactRegistrySkillMatch(
    registry: import('../registry/index.js').SkillRegistryBase,
    skill: RegistrySkill,
    query: string
): boolean {
    const normalizedQuery = normalizeRegistryToken(query);
    if (!normalizedQuery) return false;
    return [skill.name, skill.id, getRegistrySkillFullName(registry, skill)].some(
        (value) => normalizeRegistryToken(String(value || '')) === normalizedQuery
    );
}

function scoreSearchRelevance(skill: RegistrySearchSkill, query: string): number {
    const q = query.toLowerCase();
    const name = skill.skillName.toLowerCase();
    const fullName = skill.fullName.toLowerCase();
    const desc = skill.description.toLowerCase();

    if (name === q || fullName === q) return 100;
    if (name.includes(q) || fullName.includes(q)) return 50;
    if (desc.includes(q)) return 30;
    return 0;
}

function scoreRegistrySkillMatch(
    registry: import('../registry/index.js').SkillRegistryBase,
    skill: RegistrySkill,
    query: string
): number {
    const normalizedQuery = query.toLowerCase();
    const name = String(skill.name || '').toLowerCase();
    const id = String(skill.id || '').toLowerCase();
    const fullName = getRegistrySkillFullName(registry, skill).toLowerCase();
    if (fullName === normalizedQuery) return 110;
    if (name === normalizedQuery || id === normalizedQuery) return 100;
    if (name.endsWith('/' + normalizedQuery) || id.endsWith('/' + normalizedQuery)) return 90;
    if (name.includes(normalizedQuery) || id.includes(normalizedQuery)) return 50;
    return 0;
}

// ── SkillInstallManager ──────────────────────────────────────────────────

/**
 * 技能安装管理器：统一安装入口路由、注册表搜索匹配与卸载。
 * 通过构造注入 SkillRegistry 实例，复用其技能解析（_loadSkillFromDir）、
 * 已安装判断（skillExists）与刷新（refresh）能力。
 */
export class SkillInstallManager {
    private readonly registry: SkillRegistry;

    constructor(options: { registry: SkillRegistry }) {
        this.registry = options.registry;
    }

    // ── 安装入口 ──────────────────────────────────────────────────────────

    /** 从本地目录安装（force=true 时覆盖已存在的同名技能） */
    installFromDirectory(
        sourceDir: string,
        options: { force?: boolean; refresh?: boolean; fallbackName?: string } = {}
    ): Promise<InstallSkillResult> {
        return this._runInstaller(
            () =>
                new LocalDirectoryInstaller({
                    registry: this.registry,
                    sourceDir,
                    conflictPolicy: options.force ? { action: 'overwrite' } : undefined
                }),
            options
        );
    }

    /** 从本地 zip 文件安装 */
    installFromLocalZip(
        zipPath: string,
        skillRelPath?: string,
        options: { force?: boolean; refresh?: boolean } = {}
    ): Promise<InstallSkillResult> {
        return this._runInstaller(
            () =>
                new LocalZipInstaller({
                    registry: this.registry,
                    zipPath,
                    skillRelPath,
                    conflictPolicy: options.force ? { action: 'overwrite' } : undefined
                }),
            options
        );
    }

    /** 从通用 http(s) URL 下载 zip 安装 */
    installFromUrl(
        url: string,
        options: { force?: boolean; customName?: string; refresh?: boolean } = {}
    ): Promise<InstallSkillResult> {
        return this._runInstaller(
            () =>
                new HttpUrlInstaller({
                    registry: this.registry,
                    url,
                    conflictPolicy: this._policy(options.force, options.customName)
                }),
            options
        );
    }

    /** 从 GitHub 仓库 / tree 路径安装 */
    installFromGitHubUrl(
        githubUrl: string,
        options: { force?: boolean; customName?: string; refresh?: boolean } = {}
    ): Promise<InstallSkillResult> {
        return this._runInstaller(
            () =>
                new GitHubUrlInstaller({
                    registry: this.registry,
                    url: githubUrl,
                    conflictPolicy: this._policy(options.force, options.customName)
                }),
            options
        );
    }

    /** 从 ClawHub slug 安装 */
    installFromClawHubSlug(
        slug: string,
        version?: string,
        options: { force?: boolean; customName?: string; refresh?: boolean } = {}
    ): Promise<InstallSkillResult> {
        return this._runInstaller(
            () =>
                new RegistrySlugInstaller({
                    registry: this.registry,
                    registryId: 'clawhub',
                    slug,
                    version,
                    conflictPolicy: this._policy(options.force, options.customName)
                }),
            options
        );
    }

    /** 从 Matrix slug 安装 */
    installFromMatrixSlug(
        slug: string,
        options: { force?: boolean; customName?: string; refresh?: boolean } = {}
    ): Promise<InstallSkillResult> {
        return this._runInstaller(
            () =>
                new RegistrySlugInstaller({
                    registry: this.registry,
                    registryId: 'matrix',
                    slug,
                    conflictPolicy: this._policy(options.force, options.customName)
                }),
            options
        );
    }

    /** 从 SkillHub slug 安装 */
    installFromSkillHubSlug(
        slug: string,
        options: { force?: boolean; customName?: string; refresh?: boolean } = {}
    ): Promise<InstallSkillResult> {
        return this._runInstaller(
            () =>
                new RegistrySlugInstaller({
                    registry: this.registry,
                    registryId: 'skillhub',
                    slug,
                    conflictPolicy: this._policy(options.force, options.customName)
                }),
            options
        );
    }

    /** 从 ModelScope slug 安装（多下载源回退：modelscope → clawhub → skillhub） */
    async installFromModelScopeSlug(
        slug: string,
        options: { force?: boolean; customName?: string; refresh?: boolean } = {}
    ): Promise<InstallSkillResult> {
        const safeSlug = String(slug || '').trim();
        if (!safeSlug) return { success: false, error: '请提供 ModelScope 技能名称' };

        if (safeSlug.includes('/')) {
            const msUrl = `https://www.modelscope.cn/api/v1/skills/${safeSlug}/archive/zip/master`;
            const result = await this.installFromUrl(msUrl, options);
            if (result.success || isSkillConflictError(result)) return result;
        }

        const nameOnly = safeSlug.includes('/') ? safeSlug.split('/').pop()! : safeSlug;
        const clawhubResult = await this.installFromClawHubSlug(nameOnly, undefined, options);
        if (clawhubResult.success || isSkillConflictError(clawhubResult)) return clawhubResult;
        const skillhubResult = await this.installFromSkillHubSlug(nameOnly, options);
        if (skillhubResult.success || isSkillConflictError(skillhubResult)) return skillhubResult;

        return { success: false, error: `ModelScope 技能「${safeSlug}」安装失败：所有下载源均不可用` };
    }

    /** 按 installUrl 类型分发到对应安装器（GUI 卡片 / 渲染进程统一入口） */
    async installFromRegistryInstallUrl(
        installUrl: string,
        options: { force?: boolean; customName?: string; refresh?: boolean } = {}
    ): Promise<InstallSkillResult> {
        await ensureSkillRegistriesSynced();
        const method = getInstallMethod(installUrl);
        if (['clawhub', 'matrix', 'modelscope', 'skillhub'].includes(method)) {
            const parsed = parseInstallUrl(installUrl);
            if (!parsed) return { success: false, error: `无效的 ${method} installUrl` };
            if (method === 'clawhub') return this.installFromClawHubSlug(parsed.slug, parsed.version, options);
            if (method === 'matrix') return this.installFromMatrixSlug(parsed.slug, options);
            if (method === 'modelscope') return this.installFromModelScopeSlug(parsed.slug, options);
            return this.installFromSkillHubSlug(parsed.slug, options);
        }
        if (method === 'github') {
            return this.installFromGitHubUrl(installUrl, options);
        }
        // 插件贡献的注册表：优先使用定义声明的 resolveInstall 解析下载地址，
        // 未声明时保持原行为（按普通 zip URL 尝试下载）
        const parsed = parseInstallUrl(installUrl);
        if (parsed) {
            const registry = getRegistry(method);
            if (registry && typeof (registry as ContributedSkillRegistry).resolveInstall === 'function') {
                const plan = await (registry as ContributedSkillRegistry).resolveInstall(installUrl, parsed);
                if (plan?.downloadUrl) return this.installFromUrl(plan.downloadUrl, options);
            }
        }
        return this.installFromUrl(installUrl, options);
    }

    // ── 卸载 ──────────────────────────────────────────────────────────────

    /**
     * 删除指定技能（按 id，即目录名）
     * 使用 fs.rmSync 替代手动 rmRecursive，以兼容鸿蒙 HarmonyOS（unlinkSync 后文件句柄缓存等问题）
     * @param skillId - 技能 id（目录名）
     * @param refresh - 是否立即刷新全局缓存与 toolset。批量删除时应设为 false，循环结束后统一 refresh()
     */
    deleteSkill(skillId: string, refresh: boolean = true): InstallSkillResult {
        if (!skillId || typeof skillId !== 'string') {
            return { success: false, error: '请指定要删除的技能' };
        }
        const safeName = path.basename(skillId).replace(/[/\\]/g, '');
        if (!safeName) return { success: false, error: '无效的技能 id' };
        const skillsDir = path.resolve(this.registry.getSkillsDirectory());

        // 优先从缓存中获取真实目录路径，解决 skillId 与实际目录名不一致的问题
        // 例如 SKILL.md 中 name 为 resume-cv-assistant，但目录名为 resume-cv-assistant-1
        this.registry._ensureLoaded();
        const cached = this.registry._getCachedSkillEntry(safeName);
        let targetDir: string | null = cached ? (cached.skillDir ?? null) : null;
        if (!targetDir) {
            targetDir = path.resolve(skillsDir, safeName);
        }

        const relative = path.relative(skillsDir, targetDir);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { success: false, error: '无效的技能路径' };
        }
        if (!pathEntryExists(targetDir)) {
            return { success: false, error: `技能 "${safeName}" 不存在` };
        }
        try {
            // 某些平台的 rmSync 会留下悬空链接；直接 unlink 也不会删除链接目标。
            if (fs.lstatSync(targetDir).isSymbolicLink()) {
                fs.unlinkSync(targetDir);
            } else if (typeof fs.rmSync === 'function') {
                fs.rmSync(targetDir, { recursive: true, force: true });
            } else {
                rmRecursive(targetDir);
            }
            // 从缓存中移除（即使 refresh=false 也移除，保证后续 refresh() 不会重新加载已删除的 skill）
            this.registry._removeCachedSkill(safeName);
            if (refresh) {
                this.registry.refresh();
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: `删除失败: ${toErrorMessage(e)}` };
        }
    }

    // ── 注册表信息与搜索 ──────────────────────────────────────────────────

    getRegistriesInfo() {
        return getRegistryInfoList();
    }

    searchRegistry(registryId: string, opts: SearchOptions = {}) {
        return searchSingleRegistry(registryId, opts);
    }

    /** 在所有注册表搜索技能，返回 GUI 卡片安装元数据 */
    async searchSkillsFromAllRegistries(
        keyword: string,
        options: { limit?: number; skillsmpApiKey?: string } = {}
    ): Promise<RegistrySearchResult> {
        await ensureSkillRegistriesSynced();
        const query = String(keyword || '').trim();
        if (!query) {
            return { results: [], errors: [{ registryName: 'all', error: '请提供技能名称关键字' }] };
        }

        const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100));
        const settled = await Promise.allSettled(
            allRegistries.map(async (registry) => {
                const result = await this.searchRegistry(registry.id, {
                    query,
                    page: 1,
                    limit,
                    apiKey: registry.id === 'skillsmp' ? options.skillsmpApiKey : undefined
                });
                return {
                    registry,
                    skills: (result.skills || []).map((skill) => mapRegistrySkill(registry, skill))
                };
            })
        );

        const results: RegistrySearchSkill[] = [];
        const errors: Array<{ registryName: string; error: string }> = [];
        for (let i = 0; i < settled.length; i++) {
            const item = settled[i];
            if (item.status === 'fulfilled') {
                results.push(...item.value.skills);
            } else {
                errors.push({
                    registryName: allRegistries[i]?.id || 'unknown',
                    error: (item.reason as any)?.message || String(item.reason)
                });
            }
        }

        results.sort((a, b) => {
            const scoreA = scoreSearchRelevance(a, query);
            const scoreB = scoreSearchRelevance(b, query);
            if (scoreB !== scoreA) return scoreB - scoreA;
            if (b.installCount !== a.installCount) return b.installCount - a.installCount;
            return a.fullName.localeCompare(b.fullName);
        });

        return { results, errors };
    }

    /** 按 registry 名称 + 技能名称安装（搜索匹配后走同一 installUrl 路径） */
    async installSkillFromRegistryByName(
        registryName: string,
        skillName: string,
        options: RegistryInstallOptions = {}
    ): Promise<
        InstallSkillResult & { registryName?: string; matchedSkill?: string; candidates?: RegistrySearchSkill[] }
    > {
        await ensureSkillRegistriesSynced();
        const registry = normalizeRegistryName(registryName);
        if (!registry) {
            return { success: false, error: `未知 Registry: ${registryName}` };
        }
        const normalizedRequest = normalizeRequestedRegistrySkillName(registry, skillName);
        if (normalizedRequest.error) {
            return { success: false, error: normalizedRequest.error, registryName: registry.id };
        }
        const query = normalizedRequest.query;
        if (!query) {
            return { success: false, error: '请提供技能名称' };
        }

        const result = await this.searchRegistry(registry.id, {
            query,
            page: 1,
            limit: 30,
            apiKey: registry.id === 'skillsmp' ? options.skillsmpApiKey : undefined
        });
        const installable = (result.skills || []).filter((skill) => skill.canInstall && skill.installUrl);
        const exactCandidates = installable.filter((skill) => isExactRegistrySkillMatch(registry, skill, query));
        const scoredCandidates = installable
            .map((skill) => ({ skill, score: scoreRegistrySkillMatch(registry, skill, query) }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return (b.skill.downloads ?? 0) - (a.skill.downloads ?? 0);
            });

        let matched: RegistrySkill | null = null;
        if (exactCandidates.length === 1) {
            matched = exactCandidates[0];
        } else if (exactCandidates.length > 1) {
            const candidates = exactCandidates.map((skill) => mapRegistrySkill(registry, skill));
            return {
                success: false,
                error: `在 ${registry.label} 中匹配到多个同名技能，请使用 searchSkillFromRegistry 返回的更精确名称`,
                registryName: registry.id,
                candidates
            };
        } else if (installable.length === 1) {
            matched = installable[0];
        } else if (scoredCandidates.length === 1) {
            matched = scoredCandidates[0].skill;
        } else {
            const candidates = (scoredCandidates.length > 0 ? scoredCandidates.map(({ skill }) => skill) : installable)
                .slice(0, 10)
                .map((skill) => mapRegistrySkill(registry, skill));
            return {
                success: false,
                error:
                    candidates.length > 0
                        ? `在 ${registry.label} 中匹配到多个技能，请先用 searchSkillFromRegistry 搜索并传入精确 skillName/fullName`
                        : `在 ${registry.label} 中未找到可安装技能: ${query}`,
                registryName: registry.id,
                candidates
            };
        }

        const existingSkillName = String(matched.name || '');
        const skillExists = options.skillExists ?? ((name: string) => this.registry.skillExists(name));
        const force = options.force ?? false;
        if (existingSkillName && skillExists(existingSkillName) && !force) {
            return {
                success: false,
                error: `技能「${existingSkillName}」已存在，请设置 force=true 覆盖安装`,
                registryName: registry.id,
                matchedSkill: matched.name || matched.id
            };
        }

        const install =
            options.install ??
            ((installUrl: string, force: boolean) => this.installFromRegistryInstallUrl(installUrl, { force }));
        const installResult = await install(matched.installUrl, force);
        return {
            ...installResult,
            registryName: registry.id,
            matchedSkill: matched.name || matched.id
        };
    }

    // ── 内部辅助 ──────────────────────────────────────────────────────────

    /** 构造冲突策略：customName（重命名）优先于 force（覆盖），否则默认 reject */
    private _policy(force?: boolean, customName?: string): SkillInstallConflictPolicy {
        if (customName) return { action: 'rename', name: customName };
        if (force) return { action: 'overwrite' };
        return REJECT_CONFLICT;
    }

    private async _runInstaller(
        create: () => SkillSourceInstaller,
        options: { refresh?: boolean; fallbackName?: string } = {}
    ): Promise<InstallSkillResult> {
        let installer: SkillSourceInstaller;
        try {
            installer = create();
        } catch (e: any) {
            return { success: false, error: e?.message || '安装失败' };
        }
        return installer.install({ refresh: options.refresh, fallbackName: options.fallbackName });
    }
}

/** 单例实例 */
export const skillInstallManager = new SkillInstallManager({ registry: SkillRegistry.getInstance() });
