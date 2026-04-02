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

import fs from 'fs'
import path from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { logger } from '../../utils/logger.js'
import { getAppDirectory } from '../../utils/setting.js'

export interface SoulFrontmatter {
    uid: string
    name: string
    description: string
    author?: string
    created?: string
    updated?: string
    [key: string]: string | undefined
}

export interface SoulInfo {
    uid: string
    name: string
    description: string
    author?: string
    created?: string
    updated?: string
}

export interface SoulData {
    frontmatter: SoulFrontmatter
    body: string
}

interface SoulState {
    activeSoulUid: string
}

const DEFAULT_SOUL_UID = 'default'

const DEFAULT_SOUL_CONTENT = `
---
uid: default
name: OpenDesk
description: OpenDesk 默认人设
author: system
---

# OpenDesk 默认人设

你是 OpenDesk，一个友好且专业的 AI 助手。

## 性格特点

- **务实高效**：直接解决问题，不说废话。回答简洁有力，代码干净利落。
- **坦诚直率**：有自己的观点和判断。如果用户的方案有问题，会直接指出并给出更好的建议。
- **好奇心强**：对技术问题充满热情，乐于深入探索和研究。
- **幽默感**：适度的幽默让交流更愉快，但不会影响专业性。

## 沟通风格

- 用中文与用户交流（除非用户使用其他语言）
- 回答要有信息量，避免空洞的客套话（不要说"好的！"、"没问题！"之类的开场白）
- 对于复杂问题，先给结论再展开分析
- 代码示例要可运行、有注释

## 原则

- 先理解问题，再动手解决。不确定时主动确认，而非盲目猜测。
- 尊重用户的时间。能一次说清楚的事情不要分多次。
- 犯了错要坦然承认并纠正。
`

function parseSoulMd(raw: string): SoulData {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('---')) {
        return {
            frontmatter: { uid: 'unknown', name: 'unknown', description: '' },
            body: trimmed,
        }
    }
    const secondDash = trimmed.indexOf('\n---', 3)
    if (secondDash === -1) {
        return {
            frontmatter: { uid: 'unknown', name: 'unknown', description: '' },
            body: trimmed,
        }
    }
    const frontmatterRaw = trimmed.slice(3, secondDash).trim()
    const body = trimmed.slice(secondDash + 4).trim()
    let frontmatter: SoulFrontmatter
    try {
        frontmatter = parseYaml(frontmatterRaw) as SoulFrontmatter
    } catch {
        frontmatter = { uid: 'unknown', name: 'unknown', description: '' }
    }
    return { frontmatter, body }
}

function buildSoulMd(frontmatter: SoulFrontmatter, body: string): string {
    const yamlStr = stringifyYaml(frontmatter).trim()
    return `---\n${yamlStr}\n---\n\n${body}\n`
}

function generateUid(): string {
    return crypto.randomUUID()
}

/**
 * 获取 soul 数据目录，保持与原 soulmgr 应用一致的路径以兼容已有数据。
 */
function getSoulDataDirectory(): string {
    const dataDirectory = path.join(getAppDirectory(), 'apps', 'soulmgr')
    if (!fs.existsSync(dataDirectory)) {
        fs.mkdirSync(dataDirectory, { recursive: true })
    }
    return dataDirectory
}

export class SoulRegistry {
    private static instance: SoulRegistry | null = null
    private soulsDirectory: string
    private stateFilePath: string

    private constructor(dataDirectory: string) {
        this.soulsDirectory = path.join(dataDirectory, 'souls')
        this.stateFilePath = path.join(dataDirectory, 'state.json')
        this.ensureDirectories()
        this.ensureDefaultSoul()
    }

    static initialize(): SoulRegistry {
        if (!SoulRegistry.instance) {
            SoulRegistry.instance = new SoulRegistry(getSoulDataDirectory())
        }
        return SoulRegistry.instance
    }

    static getInstance(): SoulRegistry | null {
        return SoulRegistry.instance
    }

    static getActiveSoulUid(): string {
        return SoulRegistry.instance?.getActiveSoulUid() ?? DEFAULT_SOUL_UID
    }

    static getActiveSoulName(): string {
        if (SoulRegistry.instance) {
            return SoulRegistry.instance.getActiveSoulInfo()?.name ?? 'OpenDesk'
        }
        return 'OpenDesk'
    }

    static getActiveSoulContent(): string {
        if (SoulRegistry.instance) {
            const content = SoulRegistry.instance.getActiveSoulContent()
            if (content) return content
        }
        const { body } = parseSoulMd(DEFAULT_SOUL_CONTENT)
        return body
    }

    private ensureDirectories(): void {
        if (!fs.existsSync(this.soulsDirectory)) {
            fs.mkdirSync(this.soulsDirectory, { recursive: true })
        }
    }

    private ensureDefaultSoul(): void {
        const defaultPath = path.join(this.soulsDirectory, `${DEFAULT_SOUL_UID}.md`)
        if (!fs.existsSync(defaultPath)) {
            fs.writeFileSync(defaultPath, DEFAULT_SOUL_CONTENT, 'utf-8')
            logger.info('[soul] created default soul')
        }

        if (!fs.existsSync(this.stateFilePath)) {
            this.saveState({ activeSoulUid: DEFAULT_SOUL_UID })
        }
    }

    private loadState(): SoulState {
        try {
            if (fs.existsSync(this.stateFilePath)) {
                const raw = fs.readFileSync(this.stateFilePath, 'utf-8')
                const parsed = JSON.parse(raw)
                if (parsed.activeSoulUid) return parsed
                if (parsed.activeSoul) return { activeSoulUid: parsed.activeSoul }
            }
        } catch (err) {
            logger.warn(`[soul] failed to load state: ${err}`)
        }
        return { activeSoulUid: DEFAULT_SOUL_UID }
    }

    private saveState(state: SoulState): void {
        try {
            fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8')
        } catch (err) {
            logger.error(`[soul] failed to save state: ${err}`)
        }
    }

    private soulFilePath(uid: string): string {
        return path.join(this.soulsDirectory, `${uid}.md`)
    }

    getActiveSoulUid(): string {
        return this.loadState().activeSoulUid
    }

    getActiveSoulContent(): string {
        const activeUid = this.getActiveSoulUid()
        const soul = this.getSoul(activeUid)
        if (soul) {
            return soul.body
        }

        logger.warn(`[soul] active soul ${activeUid} not found, falling back to default`)
        const defaultSoul = this.getSoul(DEFAULT_SOUL_UID)
        return defaultSoul?.body ?? ''
    }

    getActiveSoulInfo(): SoulInfo | null {
        const activeUid = this.getActiveSoulUid()
        let soul = this.getSoul(activeUid)
        if (!soul) {
            if (activeUid !== DEFAULT_SOUL_UID) {
                logger.warn(`[soul] active soul ${activeUid} not found, falling back to default`)
                soul = this.getSoul(DEFAULT_SOUL_UID)
            }
            if (!soul) return null
        }
        const fm = soul.frontmatter
        return {
            uid: fm.uid,
            name: fm.name,
            description: fm.description,
            author: fm.author,
            created: fm.created,
            updated: fm.updated,
        }
    }

    listSouls(): SoulInfo[] {
        const results: SoulInfo[] = []
        try {
            const files = fs.readdirSync(this.soulsDirectory).filter((f) => f.endsWith('.md'))
            for (const file of files) {
                const filePath = path.join(this.soulsDirectory, file)
                const raw = fs.readFileSync(filePath, 'utf-8')
                const { frontmatter } = parseSoulMd(raw)
                results.push({
                    uid: frontmatter.uid || path.basename(file, '.md'),
                    name: frontmatter.name || '未命名',
                    description: frontmatter.description || '',
                    author: frontmatter.author,
                    created: frontmatter.created,
                    updated: frontmatter.updated,
                })
            }
        } catch (err) {
            logger.error(`[soul] failed to list souls: ${err}`)
        }
        return results
    }

    getSoul(uid: string): SoulData | null {
        const filePath = this.soulFilePath(uid)
        if (!fs.existsSync(filePath)) return null
        try {
            const raw = fs.readFileSync(filePath, 'utf-8')
            return parseSoulMd(raw)
        } catch (err) {
            logger.error(`[soul] failed to read soul ${uid}: ${err}`)
            return null
        }
    }

    createSoul(
        name: string,
        description: string,
        body: string,
        author?: string
    ): { success: boolean; uid?: string; error?: string } {
        const uid = generateUid()
        const now = new Date().toISOString()
        const frontmatter: SoulFrontmatter = {
            uid,
            name,
            description,
            author: author || 'user',
            created: now,
            updated: now,
        }
        try {
            fs.writeFileSync(this.soulFilePath(uid), buildSoulMd(frontmatter, body), 'utf-8')
            logger.info(`[soul] created soul: ${uid} (${name})`)
            return { success: true, uid }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }

    updateSoul(
        uid: string,
        updates: { name?: string; description?: string; body?: string }
    ): { success: boolean; error?: string } {
        const filePath = this.soulFilePath(uid)
        if (!fs.existsSync(filePath)) {
            return { success: false, error: `人设 (uid=${uid}) 不存在` }
        }
        try {
            const raw = fs.readFileSync(filePath, 'utf-8')
            const { frontmatter, body } = parseSoulMd(raw)
            if (updates.name !== undefined) {
                frontmatter.name = updates.name
            }
            if (updates.description !== undefined) {
                frontmatter.description = updates.description
            }
            frontmatter.updated = new Date().toISOString()
            const newBody = updates.body !== undefined ? updates.body : body
            fs.writeFileSync(filePath, buildSoulMd(frontmatter, newBody), 'utf-8')
            logger.info(`[soul] updated soul: ${uid} (${frontmatter.name})`)
            return { success: true }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }

    deleteSoul(uid: string): { success: boolean; error?: string } {
        if (uid === DEFAULT_SOUL_UID) {
            return { success: false, error: '不能删除默认人设' }
        }
        const filePath = this.soulFilePath(uid)
        if (!fs.existsSync(filePath)) {
            return { success: false, error: `人设 (uid=${uid}) 不存在` }
        }
        try {
            fs.unlinkSync(filePath)
            const state = this.loadState()
            if (state.activeSoulUid === uid) {
                state.activeSoulUid = DEFAULT_SOUL_UID
                this.saveState(state)
                logger.info(`[soul] active soul reset to default after deleting ${uid}`)
            }
            logger.info(`[soul] deleted soul: ${uid}`)
            return { success: true }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }

    switchSoul(uid: string): { success: boolean; error?: string } {
        const filePath = this.soulFilePath(uid)
        if (!fs.existsSync(filePath)) {
            return { success: false, error: `人设 (uid=${uid}) 不存在` }
        }
        const state = this.loadState()
        state.activeSoulUid = uid
        this.saveState(state)
        logger.info(`[soul] switched active soul to: ${uid}`)
        return { success: true }
    }

    resetDefaultSoul(): { success: boolean; error?: string } {
        const defaultPath = path.join(this.soulsDirectory, `${DEFAULT_SOUL_UID}.md`)
        try {
            fs.writeFileSync(defaultPath, DEFAULT_SOUL_CONTENT, 'utf-8')
            logger.info('[soul] reset default soul to initial state')
            return { success: true }
        } catch (err) {
            return { success: false, error: String(err) }
        }
    }

    getSoulsDirectory(): string {
        return this.soulsDirectory
    }
}
