import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { getPlatform } from '../../../platforms/base.js';
import { SkillRegistry } from './skillregistry.js';
import { RegistryAdapters } from './registry-adapters.js';
import { getTempDir } from '../../utils/temp.js';

const SKILL_MD_FILENAME = 'SKILL.md';
const ZIP_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const GITHUB_ZIP_TIMEOUT_MS = 60000;

export interface InstallSkillResult {
    success: boolean;
    name?: string;
    error?: string;
}

function rmRecursive(p: string): void {
    if (!fs.existsSync(p)) return;
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
        // ignore cleanup errors
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
    const skillMdAt = path.join(rootDir, SKILL_MD_FILENAME);
    if (fs.existsSync(skillMdAt) && fs.statSync(skillMdAt).isFile()) {
        return rootDir;
    }

    if (relPath && typeof relPath === 'string') {
        const parts = relPath.split('/').filter(Boolean);
        if (parts.length > 0) {
            const candidate = path.join(rootDir, ...parts);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                const md = path.join(candidate, SKILL_MD_FILENAME);
                if (fs.existsSync(md)) return candidate;
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

export function installSkillFromDirectory(sourceDir: string, force: boolean = false): InstallSkillResult {
    return SkillRegistry.addSkillFromDirectory(sourceDir, force);
}

export function installSkillFromLocalZip(
    zipPath: string,
    skillRelPath?: string,
    force: boolean = false
): InstallSkillResult {
    if (!zipPath || typeof zipPath !== 'string') {
        return { success: false, error: '请选择有效的 zip 文件' };
    }
    const resolved = path.resolve(zipPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return { success: false, error: '文件不存在或不是文件' };
    }
    if (path.extname(resolved).toLowerCase() !== '.zip') {
        return { success: false, error: '请选择 .zip 格式的压缩包' };
    }

    const tmpDir = path.join(getTempDir(), `skill-zip-${Date.now()}`);
    const safeRelPath = skillRelPath && typeof skillRelPath === 'string' ? skillRelPath.trim() : '';

    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const zip = new AdmZip(resolved);
        const sizeResult = getZipUncompressedSize(zip);
        if (sizeResult.error) return { success: false, error: sizeResult.error };

        zip.extractAllTo(tmpDir, true);
        const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
        const extractRoot =
            entries.length === 1 && entries[0].isDirectory() ? path.join(tmpDir, entries[0].name) : tmpDir;
        const skillRoot = safeRelPath
            ? findSkillRootInDir(extractRoot, safeRelPath)
            : findSkillRootInDir(extractRoot, null);
        if (!skillRoot) {
            return { success: false, error: '压缩包内未找到含 SKILL.md 的技能目录' };
        }
        return SkillRegistry.addSkillFromDirectory(skillRoot, force);
    } catch (e: any) {
        return { success: false, error: e?.message || '解压或添加失败' };
    } finally {
        rmRecursive(tmpDir);
    }
}

export async function installSkillFromUrl(url: string, force: boolean = false): Promise<InstallSkillResult> {
    if (!url || typeof url !== 'string') {
        return { success: false, error: '请提供有效的 URL' };
    }
    const trimmed = url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return { success: false, error: 'URL 须以 http:// 或 https:// 开头' };
    }

    const tmpDir = path.join(getTempDir(), `skill-download-${Date.now()}`);
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const res = await getPlatform().fetch(trimmed, { redirect: 'follow' });
        if (!res.ok) {
            return { success: false, error: `下载失败: ${res.status} ${res.statusText}` };
        }
        const zipBuffer = Buffer.from(await res.arrayBuffer());
        const zipPath = path.join(tmpDir, 'download.zip');
        fs.writeFileSync(zipPath, zipBuffer);
        return installSkillFromLocalZip(zipPath, undefined, force);
    } catch (e: any) {
        return { success: false, error: e?.message || '下载或安装失败' };
    } finally {
        rmRecursive(tmpDir);
    }
}

export async function installSkillFromGitHubUrl(
    githubUrl: string,
    force: boolean = false
): Promise<InstallSkillResult> {
    let parsed = parseGitHubTreeUrl(githubUrl);
    if (!parsed) {
        const repoMatch = githubUrl.trim().match(/github\.com\/([^/]+)\/([^/?#]+)/i);
        if (repoMatch) {
            parsed = { owner: repoMatch[1], repo: repoMatch[2].replace(/\.git$/, ''), branch: 'main', path: '' };
        }
    }
    if (!parsed) {
        return {
            success: false,
            error: '无效的 GitHub 技能 URL'
        };
    }
    const { owner, repo, branch, path: relPath } = parsed;

    const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
    const tmpDir = path.join(getTempDir(), `skill-github-${Date.now()}`);

    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const res = await fetchGitHubZipWithFallback(zipUrl);
        if (!res.ok) {
            return { success: false, error: `下载失败: ${res.status} ${res.statusText}` };
        }
        const zipBuffer = Buffer.from(await res.arrayBuffer());
        const zipPath = path.join(tmpDir, 'repo.zip');
        fs.writeFileSync(zipPath, zipBuffer);
        return installSkillFromLocalZip(zipPath, relPath || undefined);
    } catch (e: any) {
        return { success: false, error: e?.message || '下载或安装失败' };
    } finally {
        rmRecursive(tmpDir);
    }
}

export async function installSkillFromClawHubSlug(
    slug: string,
    version?: string,
    force: boolean = false
): Promise<InstallSkillResult> {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
        return { success: false, error: '请提供 ClawHub 技能 slug（如 my-skill）' };
    }
    const safeSlug = slug.trim();
    const params = new URLSearchParams({ slug: safeSlug });
    if (version && String(version).trim()) {
        params.set('version', String(version).trim());
    }
    const downloadUrl = `${CLAWHUB_DOWNLOAD_URL}?${params}`;
    return installSkillFromUrl(downloadUrl, force);
}

export async function installSkillFromMatrixSlug(slug: string, force: boolean = false): Promise<InstallSkillResult> {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
        return { success: false, error: '请提供 Matrix Skill 的英文名称（如 test-master）' };
    }
    const safeSlug = slug.trim();
    const downloadUrl = `https://matrix.openharmony.cn/api/registry/skill/${encodeURIComponent(safeSlug)}/install?format=zip`;
    return installSkillFromUrl(downloadUrl, force);
}

const SKILLHUB_DOWNLOAD_URL = 'https://api.skillhub.tencent.com/api/v1/download';
const CLAWHUB_DOWNLOAD_URL = 'https://wry-manatee-359.convex.site/api/v1/download';

export async function installSkillFromSkillHubSlug(slug: string, force: boolean = false): Promise<InstallSkillResult> {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
        return { success: false, error: '请提供 SkillHub 技能 slug' };
    }
    const downloadUrl = `${SKILLHUB_DOWNLOAD_URL}?slug=${encodeURIComponent(slug.trim())}`;
    return installSkillFromUrl(downloadUrl, force);
}

export async function installSkillFromModelScopeSlug(
    slug: string,
    force: boolean = false
): Promise<InstallSkillResult> {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
        return { success: false, error: '请提供 ModelScope 技能名称' };
    }
    const safeSlug = slug.trim();

    if (safeSlug.includes('/')) {
        const msUrl = `https://www.modelscope.cn/api/v1/skills/${safeSlug}/archive/zip/master`;
        const result = await installSkillFromUrl(msUrl, force);
        if (result.success) return result;
    }

    const nameOnly = safeSlug.includes('/') ? safeSlug.split('/').pop()! : safeSlug;

    const clawhubUrl = `${CLAWHUB_DOWNLOAD_URL}?slug=${encodeURIComponent(nameOnly)}`;
    let result = await installSkillFromUrl(clawhubUrl, force);
    if (result.success) return result;

    const skillhubUrl = `${SKILLHUB_DOWNLOAD_URL}?slug=${encodeURIComponent(nameOnly)}`;
    result = await installSkillFromUrl(skillhubUrl, force);
    if (result.success) return result;

    return { success: false, error: `ModelScope 技能「${safeSlug}」安装失败：所有下载源均不可用` };
}

export async function installFromRegistryInstallUrl(
    installUrl: string,
    force: boolean = false
): Promise<InstallSkillResult> {
    const method = RegistryAdapters.getInstallMethod(installUrl);
    if (method === 'clawhub') {
        const parsed = RegistryAdapters.parseClawHubInstallUrl(installUrl);
        if (!parsed) return { success: false, error: '无效的 ClawHub installUrl' };
        return installSkillFromClawHubSlug(parsed.slug, parsed.version, force);
    }
    if (method === 'matrix') {
        const parsed = RegistryAdapters.parseMatrixInstallUrl(installUrl);
        if (!parsed) return { success: false, error: '无效的 Matrix Skill installUrl' };
        return installSkillFromMatrixSlug(parsed.slug, force);
    }
    if (method === 'modelscope') {
        const parsed = RegistryAdapters.parseModelScopeInstallUrl(installUrl);
        if (!parsed) return { success: false, error: '无效的 ModelScope installUrl' };
        return installSkillFromModelScopeSlug(parsed.slug, force);
    }
    if (method === 'skillhub') {
        const parsed = RegistryAdapters.parseSkillHubInstallUrl(installUrl);
        if (!parsed) return { success: false, error: '无效的 SkillHub installUrl' };
        return installSkillFromSkillHubSlug(parsed.slug, force);
    }
    if (method === 'github') {
        return installSkillFromGitHubUrl(installUrl, force);
    }
    return installSkillFromUrl(installUrl, force);
}
