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

export const enUs: Record<string, string> = {
    'app.name': 'Notes',

    // ========== 应用事件描述 ==========
    'appEvent.notesChanged': 'Note list changed',
    'appEvent.tagsChanged': 'Tag list changed',
    'appEvent.deletedNotesChanged': 'Recycle bin note list changed',

    // ========== 页面助手与润色 ==========
    'agent.instruct':
        "You are the notes assistant. You help the user manage, search and organize notes. This page shows the user's note list and editor.",
    'polish.prompt':
        'Polish the following text, making it more fluent and professional while preserving its meaning. Note that it comes from the note "${noteTitle}" with this context:\n${noteContext}\n\nText to polish:\n${text}\n\nReturn only the polished text, without any explanation or markup.',
    'polish.untitledNote': 'Untitled',
    'renderer.tool.listCurrentNotes.description': 'Get the titles and summaries of all notes shown on the current page',

    // ========== 错误 ==========
    'error.noteNotFound': 'Note ${id} not found',
    'error.tagNotFound': 'Tag ${name} not found',
    'error.deletedNoteNotFound': 'Note ${id} not found in the recycle bin',

    // ========== Renderer：主界面 ==========
    'renderer.note.new': 'New',
    'renderer.note.search.placeholder': 'Search notes...',
    'renderer.note.sort.updatedAt': 'Last modified',
    'renderer.note.sort.createdAt': 'Date created',
    'renderer.note.sort.title': 'Title',
    'renderer.note.tag.all': 'All tags',
    'renderer.note.deleted.entry': 'Deleted',
    'renderer.note.count.notes': '${count} notes',
    'renderer.note.count.notesShort': '${count}',
    'renderer.note.group.pinned': 'Pinned',
    'renderer.note.group.today': 'Today',
    'renderer.note.group.yesterday': 'Yesterday',
    'renderer.note.allNotes': 'All notes',
    'renderer.note.empty.noNotes': 'No notes yet',
    'renderer.note.empty.createFirst': 'Click "New" to create your first note',
    'renderer.note.untitled': 'Untitled',

    // ========== Renderer：编辑视图 ==========
    'renderer.note.editor.back': 'Back',
    'renderer.note.pin.pinned': 'Pinned',
    'renderer.note.pin.unpinned': 'Pin',
    'renderer.note.delete': 'Delete',
    'renderer.note.rename': 'Rename',
    'renderer.note.title.placeholder': 'Note title',
    'renderer.note.tag.add': 'Tags',

    // ========== Renderer：格式工具栏 ==========
    'renderer.note.color.title': 'Text color',
    'renderer.note.color.custom': 'Custom color',
    'renderer.note.color.default': 'Default',
    'renderer.note.color.red': 'Red',
    'renderer.note.color.orange': 'Orange',
    'renderer.note.color.yellow': 'Yellow',
    'renderer.note.color.green': 'Green',
    'renderer.note.color.blue': 'Blue',
    'renderer.note.color.purple': 'Purple',
    'renderer.note.color.pink': 'Pink',
    'renderer.note.color.gray': 'Gray',
    'renderer.note.undo': 'Undo',
    'renderer.note.redo': 'Redo',
    'renderer.note.bold': 'Bold',
    'renderer.note.italic': 'Italic',
    'renderer.note.underline': 'Underline',
    'renderer.note.strikethrough': 'Strikethrough',
    'renderer.note.heading1': 'Heading 1',
    'renderer.note.heading2': 'Heading 2',
    'renderer.note.heading3': 'Heading 3',
    'renderer.note.heading4': 'Heading 4',
    'renderer.note.heading5': 'Heading 5',
    'renderer.note.heading6': 'Heading 6',
    'renderer.note.body': 'Body',
    'renderer.note.list.bullet': 'Bulleted list',
    'renderer.note.list.numbered': 'Numbered list',
    'renderer.note.align.left': 'Align left',
    'renderer.note.align.center': 'Align center',
    'renderer.note.align.right': 'Align right',
    'renderer.note.blockquote': 'Quote',
    'renderer.note.link': 'Link',
    'renderer.note.image': 'Image',
    'renderer.note.code': 'Source code',
    'renderer.note.codeblock': 'Code block',
    'renderer.note.codeblock.langHint': 'Language (e.g. python)',
    'renderer.note.menu.cut': 'Cut',
    'renderer.note.menu.copy': 'Copy',
    'renderer.note.menu.paste': 'Paste',
    'renderer.note.menu.pastePlain': 'Paste as plain text',
    'renderer.note.menu.selectAll': 'Select all',
    'renderer.note.style.menu': 'Styles',

    // ========== Renderer：AI 润色 ==========
    'renderer.note.ai.polishTitle': 'AI Refine',
    'renderer.note.ai.selection': 'Refine selection',
    'renderer.note.ai.all': 'Refine all',
    'renderer.note.ai.running': 'Refining...',
    'renderer.note.ai.assistant': 'AI Assistant',
    'renderer.note.ai.trigger': 'Help me',
    'renderer.note.ai.polish': 'Refine',
    'renderer.note.ai.translate': 'Translate (coming soon)',
    'renderer.note.ai.execute': 'Run',

    // ========== Renderer：标签菜单 ==========
    'renderer.note.tag.menu.title': 'Tags',
    'renderer.note.tag.delete': 'Delete tag',
    'renderer.note.tag.new.placeholder': 'New tag...',
    'renderer.note.tag.add.button': 'Add',
    'renderer.note.tag.delete.confirm.title': 'Delete Tag',
    'renderer.note.tag.delete.confirm.message': 'Delete tag "${name}"? It will be removed from all notes.',

    // ========== Renderer：删除 / 回收站 ==========
    'renderer.note.note.delete.confirm.title': 'Delete Note',
    'renderer.note.note.delete.confirm.message':
        'Delete this note? It stays in the recycle bin for 10 days before being permanently deleted.',
    'renderer.note.deleted.empty': 'Recycle bin is empty',
    'renderer.note.deleted.clear': 'Empty recycle bin',
    'renderer.note.deleted.hint': 'Deleted notes can be restored within 10 days',
    'renderer.note.deleted.deletedAt': 'Deleted ${time}',
    'renderer.note.deleted.remaining': '${days}d until permanent deletion',
    'renderer.note.restore': 'Restore',
    'renderer.note.delete.permanent': 'Delete permanently',
    'renderer.note.permanent.confirm.message': 'Permanently delete this note? This cannot be undone.',
    'renderer.note.clear.confirm.message':
        'Permanently delete all notes in the recycle bin (${count})? This cannot be undone.',
    'renderer.note.clear.confirm.button': 'Empty',

    // ========== Renderer：通用 ==========
    'renderer.note.common.cancel': 'Cancel',
    'renderer.note.common.delete': 'Delete',

    // ========== Renderer：相对时间 ==========
    'renderer.note.time.justNow': 'Just now',
    'renderer.note.time.minutesAgo': '${n} min ago',
    'renderer.note.time.hoursAgo': '${n} h ago',
    'renderer.note.time.daysAgo': '${n} d ago'
};
