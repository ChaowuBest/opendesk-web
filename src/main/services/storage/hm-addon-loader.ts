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
 * hm-addon-loader.ts - HarmonyOS native addon 路径发现与加载
 *
 * 统一管理所有 HM 平台原生 addon（hm_sqlite_addon.node、jieba）的路径发现逻辑。
 *
 * 路径发现策略（按优先级）：
 *   1. HM_SQLITE_ADDON_PATH / HM_JIEBA_ADDON_PATH 环境变量（开发者手动覆盖）
 *   2. process.resourcesPath（Electron 打包后由框架注入）
 *   3. walk-up：从当前模块目录向上遍历，找到含 native/openharmony/ 的目录
 *      - electron-vite dev：dist/main/chunks/ → 上 3 步 → 项目根
 *      - cli bundle（dev/npm）：dist/cli/ 或包根 → 上 ≤2 步 → 项目根/包根
 */

import path from 'path';
import fs from 'fs';
import { createRequire as _createRequireHmAddon } from 'module';
import { fileURLToPath } from 'url';

const _require = _createRequireHmAddon(import.meta.url);
const _dirname = path.dirname(fileURLToPath(import.meta.url));
const _resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

// ── 类型定义 ────────────────────────────────────────────────────────

export type HmSqliteAddon = {
    open: (filename: string) => unknown;
    close: (db: unknown) => void;
    exec: (db: unknown, sql: string) => Promise<any[]>;
    beginTransaction: (db: unknown) => Promise<void>;
    commitTransaction: (db: unknown) => Promise<void>;
    rollbackTransaction: (db: unknown) => Promise<void>;
    prepare: (db: unknown, sql: string) => Promise<unknown>;
    run: (stmt: unknown, params: any[]) => Promise<void>;
};

export type JiebaInstance = {
    cut: (text: string, hmm?: boolean) => string[];
};

type JiebaAddon = {
    Jieba: {
        withEmbeddedDict?: () => JiebaInstance;
    };
};

// ── walk-up：从 _dirname 向上找到含 native/openharmony/{arch}/ 的目录 ──

function findNativeArchDir(arch: string): string | null {
    let dir = _dirname;
    for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, 'native', 'openharmony', arch);
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function getArchCandidates(): string[] {
    return [
        process.arch,
        process.arch === 'arm64' ? 'aarch64' : undefined,
        process.arch === 'x64' ? 'x86_64' : undefined
    ].filter(Boolean) as string[];
}

// ── sqlite addon ────────────────────────────────────────────────────

function getSqliteAddonCandidates(): string[] {
    const candidates: string[] = [];

    if (process.env.HM_SQLITE_ADDON_PATH) {
        candidates.push(process.env.HM_SQLITE_ADDON_PATH);
    }
    for (const arch of getArchCandidates()) {
        if (_resourcesPath) {
            candidates.push(path.join(_resourcesPath, 'native', 'openharmony', arch, 'hm_sqlite_addon_signed.node'));
            candidates.push(path.join(_resourcesPath, 'native', 'openharmony', arch, 'hm_sqlite_addon.node'));
        }
        const nativeDir = findNativeArchDir(arch);
        if (nativeDir) {
            candidates.push(path.join(nativeDir, 'hm_sqlite_addon_signed.node'));
            candidates.push(path.join(nativeDir, 'hm_sqlite_addon.node'));
        }
    }

    return [...new Set(candidates)];
}

export function loadSqliteAddon(): HmSqliteAddon {
    const candidates = getSqliteAddonCandidates();
    for (const addonPath of candidates) {
        if (!fs.existsSync(addonPath)) continue;
        return _require(addonPath) as HmSqliteAddon;
    }
    throw new Error(`hm_sqlite_addon not found. Tried: ${candidates.join(', ')}`);
}

// ── jieba addon（仅 BM25 使用）──────────────────────────────────────

function getJiebaAddonCandidates(): string[] {
    const candidates: string[] = [];

    if (process.env.HM_JIEBA_ADDON_PATH) {
        candidates.push(process.env.HM_JIEBA_ADDON_PATH);
    }

    const dirs: string[] = [];
    for (const arch of getArchCandidates()) {
        if (_resourcesPath) {
            dirs.push(path.join(_resourcesPath, 'native', 'openharmony', arch));
        }
        const nativeDir = findNativeArchDir(arch);
        if (nativeDir) {
            dirs.push(nativeDir);
        }
    }

    const jiebaNames = getArchCandidates()
        .flatMap((arch) => [
            `jieba.${arch}-unknown-linux-musl-signed.node`,
            `jieba.${arch}-unknown-linux-musl.node`,
            `jieba.${arch}-signed.node`,
            `jieba.${arch}.node`
        ])
        .concat(['hm_jieba_addon_signed.node', 'hm_jieba_addon.node', 'jieba-signed.node', 'jieba.node']);

    for (const dir of dirs) {
        for (const name of jiebaNames) {
            candidates.push(path.join(dir, name));
        }
    }

    return [...new Set(candidates)];
}

export function loadJiebaAddon(): JiebaInstance {
    const candidates = getJiebaAddonCandidates();
    let jiebaAddon: JiebaAddon | null = null;

    for (const addonPath of candidates) {
        if (!fs.existsSync(addonPath)) continue;
        jiebaAddon = _require(addonPath) as JiebaAddon;
        break;
    }

    if (!jiebaAddon) {
        throw new Error(`hm jieba addon not found. Tried: ${candidates.join(', ')}`);
    }
    if (!jiebaAddon.Jieba?.withEmbeddedDict) {
        throw new Error(
            'hm jieba addon does not support Jieba.withEmbeddedDict(). ' +
                'Please rebuild native addon with embedded dict.'
        );
    }

    return jiebaAddon.Jieba.withEmbeddedDict();
}
