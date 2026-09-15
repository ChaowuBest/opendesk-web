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
import { t } from '../locale/index.js';
import { logger } from '../../../utils/logger.js';
import path from 'path';
import fs from 'fs';

/**
 * 预设标签颜色列表
 */
const TAG_COLORS = ['#007AFF', '#FF9500', '#34C759', '#FF3B30', '#AF52DE', '#5AC8FA', '#FF2D55', '#5856D6'];
const RECYCLE_BIN_RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10天
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时清理一次

class NotesWorker extends BaseWorker {
    constructor(bundleName, appDataDirectory) {
        super(bundleName, appDataDirectory);
        this.notesData = { version: '1.0', notes: [], tags: [], deletedNotes: [], last_updated: '' };
        this.dataFile = path.join(this.appDataDirectory, 'notes.json');
        this.dataDir = path.join(this.appDataDirectory, 'data');
        this._cleanupInterval = null;
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
        this._startCleanupTimer();
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
                    deletedNotes: parsed.deletedNotes || [],
                    last_updated: parsed.last_updated || ''
                };
                // 为缺失 preview 的旧笔记补充生成
                let migrated = false;
                for (const note of this.notesData.notes) {
                    if (note.preview === undefined) {
                        note.preview = this._generatePreview(this.getNoteContentSync(note.id));
                        migrated = true;
                    }
                }
                if (migrated) {
                    logger.info('[notes] 正在为旧笔记补充 preview 字段');
                    await this._saveNotesData();
                }
            } catch (e) {
                logger.error('[notes] 加载 notes.json 失败:', e);
                this.notesData = { version: '1.0', notes: [], tags: [], deletedNotes: [], last_updated: '' };
            }
        } else {
            this.notesData = { version: '1.0', notes: [], tags: [], deletedNotes: [], last_updated: '' };
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

    /**
     * 从 HTML 内容中提取纯文本预览
     */
    _generatePreview(html) {
        if (!html) return '';
        let text = html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
        text = text.replace(/\s+/g, ' ').trim();
        return text.slice(0, 200);
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

        // 按日期范围过滤
        if (filter.startDate) {
            const startTs = new Date(filter.startDate.replace(/-/g, '/')).getTime();
            notes = notes.filter((n) => n.updatedAt >= startTs || n.createdAt >= startTs);
        }
        if (filter.endDate) {
            const endTs = new Date(filter.endDate.replace(/-/g, '/')).getTime() + 86400000;
            notes = notes.filter((n) => n.updatedAt <= endTs || n.createdAt <= endTs);
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

    async getNote(noteId) {
        return this.notesData.notes.find((n) => n.id === noteId) || null;
    }

    async getNoteContent(noteId) {
        return this.getNoteContentSync(noteId);
    }

    getNoteContentSync(noteId) {
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
            isPinned: data.isPinned || false,
            preview: this._generatePreview(data.content || '')
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
        if (idx === -1) throw new Error(t('error.noteNotFound', { id: noteId }));

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

        // 更新 updatedAt 和 preview
        const idx = this.notesData.notes.findIndex((n) => n.id === noteId);
        if (idx !== -1) {
            this.notesData.notes[idx].updatedAt = Date.now();
            this.notesData.notes[idx].preview = this._generatePreview(htmlContent);
            await this._saveNotesData();
        }
    }

    async deleteNote(noteId) {
        const idx = this.notesData.notes.findIndex((n) => n.id === noteId);
        if (idx === -1) throw new Error(t('error.noteNotFound', { id: noteId }));

        const note = this.notesData.notes[idx];

        // 读取笔记内容
        let content = '';
        const contentFile = path.join(this.dataDir, noteId, 'content.html');
        if (fs.existsSync(contentFile)) {
            content = fs.readFileSync(contentFile, 'utf-8');
        }

        // 构建回收站条目
        const now = Date.now();
        const deletedNote = {
            id: note.id,
            title: note.title,
            tags: [...note.tags],
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            isPinned: note.isPinned,
            content: content,
            deletedAt: now,
            expiresAt: now + RECYCLE_BIN_RETENTION_MS
        };

        // 从活跃笔记中移除
        this.notesData.notes.splice(idx, 1);

        // 添加到回收站
        this.notesData.deletedNotes.unshift(deletedNote);

        // 删除笔记目录（内容已保存在 deletedNote.content 中）
        const noteDir = path.join(this.dataDir, noteId);
        if (fs.existsSync(noteDir)) {
            fs.rmSync(noteDir, { recursive: true, force: true });
        }

        await this._saveNotesData();
        await this.emitEvent('notesChanged');
        await this.emitEvent('deletedNotesChanged');
        return { deleted: true, movedToRecycleBin: true };
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
        if (idx === -1) throw new Error(t('error.tagNotFound', { name }));

        this.notesData.tags.splice(idx, 1);

        // 从所有笔记中移除该标签
        for (const note of this.notesData.notes) {
            note.tags = note.tags.filter((t) => t !== name);
        }

        await this._saveNotesData();
        await this.emitEvent('tagsChanged');
        return { deleted: true };
    }

    // ─── 回收站操作 ───

    async getDeletedNotes() {
        await this._cleanupExpiredNotes();
        return this.notesData.deletedNotes;
    }

    async restoreNote(noteId) {
        const idx = this.notesData.deletedNotes.findIndex((n) => n.id === noteId);
        if (idx === -1) throw new Error(t('error.deletedNoteNotFound', { id: noteId }));

        const deletedNote = this.notesData.deletedNotes[idx];

        // 从回收站移除
        this.notesData.deletedNotes.splice(idx, 1);

        // 重建笔记目录和内容文件
        const noteDir = path.join(this.dataDir, noteId);
        fs.mkdirSync(noteDir, { recursive: true });
        const assetsDir = path.join(noteDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });
        const contentFile = path.join(noteDir, 'content.html');
        fs.writeFileSync(contentFile, deletedNote.content || '', 'utf-8');

        // 恢复到活跃笔记
        const restoredNote = {
            id: deletedNote.id,
            title: deletedNote.title,
            tags: deletedNote.tags || [],
            createdAt: deletedNote.createdAt,
            updatedAt: Date.now(),
            isPinned: deletedNote.isPinned || false,
            preview: this._generatePreview(deletedNote.content || '')
        };
        this.notesData.notes.unshift(restoredNote);

        await this._saveNotesData();
        await this.emitEvent('notesChanged');
        await this.emitEvent('deletedNotesChanged');
        return restoredNote;
    }

    async permanentlyDeleteNote(noteId) {
        const idx = this.notesData.deletedNotes.findIndex((n) => n.id === noteId);
        if (idx === -1) throw new Error(t('error.deletedNoteNotFound', { id: noteId }));

        this.notesData.deletedNotes.splice(idx, 1);

        await this._saveNotesData();
        await this.emitEvent('deletedNotesChanged');
        return { permanentlyDeleted: true, noteId };
    }

    async emptyRecycleBin() {
        this.notesData.deletedNotes = [];
        await this._saveNotesData();
        await this.emitEvent('deletedNotesChanged');
        return { emptied: true };
    }

    async _cleanupExpiredNotes() {
        const now = Date.now();
        const before = this.notesData.deletedNotes.length;
        this.notesData.deletedNotes = this.notesData.deletedNotes.filter((n) => n.expiresAt > now);
        const removed = before - this.notesData.deletedNotes.length;
        if (removed > 0) {
            logger.info(`[notes] 清理了 ${removed} 条过期回收站笔记`);
            await this._saveNotesData();
            await this.emitEvent('deletedNotesChanged');
        }
    }

    _startCleanupTimer() {
        // 首次延迟 30 秒执行，等初始化完毕
        setTimeout(() => {
            this._cleanupExpiredNotes();
        }, 30000);

        this._cleanupInterval = setInterval(() => {
            this._cleanupExpiredNotes();
        }, CLEANUP_INTERVAL_MS);

        logger.info('[notes] 回收站清理定时器已启动');
    }

    _stopCleanupTimer() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
    }
}

export default NotesWorker;
