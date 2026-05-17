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
import { z } from 'zod';

// ========== getNotes 工具 ==========

const GetNotesArgsSchema = z.object({
    searchQuery: z.string().optional().describe('搜索关键词（按标题匹配）'),
    tagFilter: z.string().optional().describe('按标签名称过滤'),
    sortBy: z.enum(['updatedAt', 'createdAt', 'title']).optional().describe('排序方式')
});

export class GetNotesTool extends BaseTool<typeof GetNotesArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super('getNotes', '获取笔记列表，支持按关键词搜索、按标签过滤和排序', GetNotesArgsSchema);
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof GetNotesArgsSchema>): Promise<string> {
        const result = await this.notesApp.callWorker('getNotes', args);
        const notes = result?.data ?? result;
        return JSON.stringify(notes);
    }
}

// ========== createNote 工具 ==========

const CreateNoteArgsSchema = z.object({
    title: z.string().describe('笔记标题'),
    content: z.string().optional().describe('笔记内容（HTML格式）'),
    tags: z.array(z.string()).optional().describe('标签列表')
});

export class CreateNoteTool extends BaseTool<typeof CreateNoteArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super('createNote', '创建一条新笔记', CreateNoteArgsSchema);
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof CreateNoteArgsSchema>): Promise<string> {
        const result = await this.notesApp.callWorker('createNote', args);
        const note = result?.data ?? result;
        return JSON.stringify(note);
    }
}

// ========== updateNote 工具 ==========

const UpdateNoteArgsSchema = z.object({
    noteId: z.string().describe('笔记ID'),
    title: z.string().optional().describe('新标题'),
    tags: z.array(z.string()).optional().describe('新标签列表'),
    isPinned: z.boolean().optional().describe('是否置顶')
});

export class UpdateNoteTool extends BaseTool<typeof UpdateNoteArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super('updateNote', '修改笔记的标题、标签或置顶状态', UpdateNoteArgsSchema);
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof UpdateNoteArgsSchema>): Promise<string> {
        const { noteId, ...updates } = args;
        const result = await this.notesApp.callWorker('updateNote', noteId, updates);
        const note = result?.data ?? result;
        return JSON.stringify(note);
    }
}

// ========== deleteNote 工具 ==========

const DeleteNoteArgsSchema = z.object({
    noteId: z.string().describe('要删除的笔记ID')
});

export class DeleteNoteTool extends BaseTool<typeof DeleteNoteArgsSchema> {
    private notesApp: any;

    constructor(notesApp: any) {
        super('deleteNote', '删除指定笔记', DeleteNoteArgsSchema);
        this.notesApp = notesApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof DeleteNoteArgsSchema>): Promise<string> {
        const result = await this.notesApp.callWorker('deleteNote', args.noteId);
        const data = result?.data ?? result;
        return JSON.stringify(data);
    }
}
