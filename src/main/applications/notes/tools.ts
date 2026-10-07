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

import { BaseTool } from '../../aikernel/tool';
import { t } from './locale/index.js';
import { z } from 'zod';

// ========== createNote 工具 ==========

const CreateNoteArgsSchema = z.object({
    title: z.string().describe('笔记标题'),
    content: z.string().optional().describe('笔记内容（HTML格式）'),
    tags: z.array(z.string()).optional().describe('标签列表'),
    isPinned: z.boolean().optional().default(false).describe('是否置顶')
});

export class CreateNoteTool extends BaseTool<typeof CreateNoteArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super('createNote', '创建一条新笔记，可指定标题、内容、标签和置顶状态', CreateNoteArgsSchema, undefined, {
            'zh-CN': '创建笔记',
            'en-US': 'Create Note'
        });
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof CreateNoteArgsSchema>): Promise<string> {
        const result = await this.notesApp.callWorker('createNote', args);
        const note = result?.data ?? result;
        return JSON.stringify(note);
    }
}

// ========== editNote 工具 ==========

const EditNoteArgsSchema = z.object({
    noteId: z.string().describe('要编辑的笔记ID'),
    title: z.string().optional().describe('新标题'),
    content: z.string().optional().describe('新内容（HTML格式）'),
    tags: z.array(z.string()).optional().describe('新标签列表'),
    isPinned: z.boolean().optional().describe('是否置顶')
});

export class EditNoteTool extends BaseTool<typeof EditNoteArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super(
            'editNote',
            '编辑已有笔记的标题、内容、标签或置顶状态，仅需提供要修改的字段',
            EditNoteArgsSchema,
            undefined,
            {
                'zh-CN': '编辑笔记',
                'en-US': 'Edit Note'
            }
        );
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof EditNoteArgsSchema>): Promise<string> {
        const { noteId, content, ...metadataUpdates } = args;

        // 先更新元数据（title, tags, isPinned）
        const metadataFields: Record<string, any> = {};
        if (metadataUpdates.title !== undefined) metadataFields.title = metadataUpdates.title;
        if (metadataUpdates.tags !== undefined) metadataFields.tags = metadataUpdates.tags;
        if (metadataUpdates.isPinned !== undefined) metadataFields.isPinned = metadataUpdates.isPinned;

        if (Object.keys(metadataFields).length > 0) {
            await this.notesApp.callWorker('updateNote', noteId, metadataFields);
        }

        // 再更新内容（如果提供了 content）
        if (content !== undefined) {
            await this.notesApp.callWorker('updateNoteContent', noteId, content);
        }

        // 获取更新后的笔记返回
        const updatedNote = await this.notesApp.callWorker('getNote', noteId);
        return JSON.stringify((updatedNote?.data ?? updatedNote) || { id: noteId, updated: true });
    }
}

// ========== readNote 工具 ==========

const ReadNoteArgsSchema = z.object({
    noteId: z.string().describe('要读取的笔记ID')
});

export class ReadNoteTool extends BaseTool<typeof ReadNoteArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super('readNote', '读取指定笔记的完整内容，包括元数据和HTML内容', ReadNoteArgsSchema, undefined, {
            'zh-CN': '阅读笔记',
            'en-US': 'Read Note'
        });
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ReadNoteArgsSchema>): Promise<string> {
        // 获取笔记元数据
        const note = await this.notesApp.callWorker('getNote', args.noteId);
        if (!note) {
            throw new Error(t('error.noteNotFound', { id: args.noteId }));
        }

        // 获取笔记内容
        const content = await this.notesApp.callWorker('getNoteContent', args.noteId);

        return JSON.stringify({
            ...(note?.data ?? note),
            content: content || ''
        });
    }
}

// ========== listNotes 工具 ==========

const ListNotesArgsSchema = z.object({
    searchQuery: z.string().optional().describe('搜索关键词（按标题匹配）'),
    tagFilter: z.string().optional().describe('按标签名称过滤'),
    startDate: z.string().optional().describe('起始日期，格式为YYYY-MM-DD'),
    endDate: z.string().optional().describe('结束日期，格式为YYYY-MM-DD'),
    sortBy: z.enum(['updatedAt', 'createdAt', 'title']).optional().describe('排序方式')
});

export class ListNotesTool extends BaseTool<typeof ListNotesArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super(
            'listNotes',
            '获取笔记列表，支持按关键词搜索、按标签过滤、按日期范围筛选和排序',
            ListNotesArgsSchema,
            undefined,
            {
                'zh-CN': '笔记列表',
                'en-US': 'List Notes'
            }
        );
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ListNotesArgsSchema>): Promise<string> {
        const result = await this.notesApp.callWorker('getNotes', args);
        const notes = result?.data ?? result;
        return JSON.stringify(notes);
    }
}

// ========== listTags 工具 ==========

const ListTagsArgsSchema = z.object({});

export class ListTagsTool extends BaseTool<typeof ListTagsArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super('listTags', '获取所有标签列表', ListTagsArgsSchema, undefined, {
            'zh-CN': '标签列表',
            'en-US': 'List Tags'
        });
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(_args: z.output<typeof ListTagsArgsSchema>): Promise<string> {
        const result = await this.notesApp.callWorker('getTags');
        const tags = result?.data ?? result;
        return JSON.stringify(tags);
    }
}

// ========== deleteNotes 工具 ==========

const DeleteNotesArgsSchema = z.object({
    noteIds: z.array(z.string()).describe('要删除的笔记ID列表，支持批量删除')
});

export class DeleteNotesTool extends BaseTool<typeof DeleteNotesArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super(
            'deleteNotes',
            '删除一条或多条笔记，删除后笔记将移入回收站，10天内可恢复',
            DeleteNotesArgsSchema,
            undefined,
            {
                'zh-CN': '删除笔记',
                'en-US': 'Delete Notes'
            }
        );
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof DeleteNotesArgsSchema>): Promise<string> {
        const results = [];
        for (const noteId of args.noteIds) {
            try {
                const result = await this.notesApp.callWorker('deleteNote', noteId);
                results.push({ noteId, success: true, ...result });
            } catch (err) {
                results.push({ noteId, success: false, error: err instanceof Error ? err.message : String(err) });
            }
        }
        return JSON.stringify(results);
    }
}
