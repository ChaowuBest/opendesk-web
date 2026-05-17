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

import { BaseWorker } from '../../base';
import { logger } from '../../../utils/logger.js';
import path from 'path';
import fs from 'fs';

/**
 * 预设标签颜色列表
 */
const TAG_COLORS = ['#007AFF', '#FF9500', '#34C759', '#FF3B30', '#AF52DE', '#5AC8FA', '#FF2D55', '#5856D6'];

class NotesWorker extends BaseWorker {
    constructor(bundleName, appDataDirectory) {
        super(bundleName, appDataDirectory);
        this.notesData = { version: '1.0', notes: [], tags: [], last_updated: '' };
        this.dataFile = path.join(this.appDataDirectory, 'notes.json');
        this.dataDir = path.join(this.appDataDirectory, 'data');
    }

    // ─── 生命周期 ───

    async initialize() {
        logger.info('[notes] NotesWorker 正在初始化...');
        if (!fs.existsSync(this.appDataDirectory)) {
            fs.mkdirSync(this.appDataDirectory, { recursive: true });
        }
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        await this._loadNotesData();
        logger.info(`[notes] NotesWorker 初始化完成，共 ${this.notesData.notes.length} 条笔记`);
    }

    // ─── 内部数据管理 ───

    async _loadNotesData() {
        if (fs.existsSync(this.dataFile)) {
            try {
                const raw = fs.readFileSync(this.dataFile, 'utf-8');
                const parsed = JSON.parse(raw);
                this.notesData = {
                    version: parsed.version || '1.0',
                    notes: parsed.notes || [],
                    tags: parsed.tags || [],
                    last_updated: parsed.last_updated || ''
                };
            } catch (e) {
                logger.error('[notes] 加载 notes.json 失败:', e);
                this.notesData = { version: '1.0', notes: [], tags: [], last_updated: '' };
            }
        } else {
            this.notesData = { version: '1.0', notes: [], tags: [], last_updated: '' };
        }
    }

    async _saveNotesData() {
        return await this.runSequentially(async () => {
            this.notesData.last_updated = new Date().toISOString();
            const dir = path.dirname(this.dataFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmpPath = this.dataFile + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(this.notesData, null, 2));
            fs.renameSync(tmpPath, this.dataFile);
        });
    }

    _generateId() {
        const timestamp = Date.now().toString(36).slice(-8);
        const random = Math.random().toString(36).slice(2, 8);
        return `note_${timestamp}_${random}`;
    }

    _pickTagColor() {
        const usedCount = this.notesData.tags.length;
        return TAG_COLORS[usedCount % TAG_COLORS.length];
    }

    // ─── CRUD 操作 ───

    async getNotes(filter = {}) {
        let notes = [...this.notesData.notes];

        // 按标签过滤
        if (filter.tagFilter) {
            notes = notes.filter((n) => n.tags.includes(filter.tagFilter));
        }

        // 按关键词搜索（标题）
        if (filter.searchQuery) {
            const query = filter.searchQuery.toLowerCase();
            notes = notes.filter((n) => n.title.toLowerCase().includes(query));
        }

        // 排序：置顶优先，然后按指定字段
        const sortBy = filter.sortBy || 'updatedAt';
        notes.sort((a, b) => {
            if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
            if (sortBy === 'title') return a.title.localeCompare(b.title);
            return b[sortBy] - a[sortBy];
        });

        return notes;
    }

    async getNoteContent(noteId) {
        const contentFile = path.join(this.dataDir, noteId, 'content.html');
        if (fs.existsSync(contentFile)) {
            return fs.readFileSync(contentFile, 'utf-8');
        }
        return '';
    }

    async createNote(data = {}) {
        const id = this._generateId();
        const now = Date.now();
        const note = {
            id,
            title: data.title || '',
            tags: data.tags || [],
            createdAt: now,
            updatedAt: now,
            isPinned: false
        };

        // 创建笔记目录和内容文件
        const noteDir = path.join(this.dataDir, id);
        fs.mkdirSync(noteDir, { recursive: true });
        const assetsDir = path.join(noteDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });

        const contentFile = path.join(noteDir, 'content.html');
        fs.writeFileSync(contentFile, data.content || '', 'utf-8');

        this.notesData.notes.unshift(note);
        await this._saveNotesData();
        await this.emitEvent('notesChanged');
        return note;
    }

    async updateNote(noteId, updates) {
        const idx = this.notesData.notes.findIndex((n) => n.id === noteId);
        if (idx === -1) throw new Error(`笔记 ${noteId} 不存在`);

        const note = this.notesData.notes[idx];
        if (updates.title !== undefined) note.title = updates.title;
        if (updates.tags !== undefined) note.tags = updates.tags;
        if (updates.isPinned !== undefined) note.isPinned = updates.isPinned;
        note.updatedAt = Date.now();

        this.notesData.notes[idx] = note;
        await this._saveNotesData();
        await this.emitEvent('notesChanged');
        return note;
    }

    async updateNoteContent(noteId, htmlContent) {
        const contentFile = path.join(this.dataDir, noteId, 'content.html');
        if (!fs.existsSync(path.dirname(contentFile))) {
            fs.mkdirSync(path.dirname(contentFile), { recursive: true });
        }
        fs.writeFileSync(contentFile, htmlContent, 'utf-8');

        // 更新 updatedAt
        const idx = this.notesData.notes.findIndex((n) => n.id === noteId);
        if (idx !== -1) {
            this.notesData.notes[idx].updatedAt = Date.now();
            await this._saveNotesData();
        }
    }

    async deleteNote(noteId) {
        const idx = this.notesData.notes.findIndex((n) => n.id === noteId);
        if (idx === -1) throw new Error(`笔记 ${noteId} 不存在`);

        this.notesData.notes.splice(idx, 1);

        // 删除笔记目录
        const noteDir = path.join(this.dataDir, noteId);
        if (fs.existsSync(noteDir)) {
            fs.rmSync(noteDir, { recursive: true, force: true });
        }

        await this._saveNotesData();
        await this.emitEvent('notesChanged');
        return { deleted: true };
    }

    // ─── 标签管理 ───

    async getTags() {
        return this.notesData.tags;
    }

    async addTag(name, color) {
        const existing = this.notesData.tags.find((t) => t.name === name);
        if (existing) return existing;

        const tag = {
            name,
            color: color || this._pickTagColor(),
            createdAt: Date.now()
        };
        this.notesData.tags.push(tag);
        await this._saveNotesData();
        await this.emitEvent('tagsChanged');
        return tag;
    }

    async deleteTag(name) {
        const idx = this.notesData.tags.findIndex((t) => t.name === name);
        if (idx === -1) throw new Error(`标签 ${name} 不存在`);

        this.notesData.tags.splice(idx, 1);

        // 从所有笔记中移除该标签
        for (const note of this.notesData.notes) {
            note.tags = note.tags.filter((t) => t !== name);
        }

        await this._saveNotesData();
        await this.emitEvent('tagsChanged');
        return { deleted: true };
    }
}

export default NotesWorker;
