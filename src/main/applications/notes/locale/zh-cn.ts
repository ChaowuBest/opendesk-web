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

export const zhCn: Record<string, string> = {
    'app.name': '笔记',

    // ========== 应用事件描述 ==========
    'appEvent.notesChanged': '笔记列表发生变化',
    'appEvent.tagsChanged': '标签列表发生变化',
    'appEvent.deletedNotesChanged': '回收站笔记列表发生变化',

    // ========== 页面助手与润色 ==========
    'agent.instruct': '你是笔记助手，帮助用户管理、搜索和整理笔记。当前页面展示了用户的笔记列表和编辑器。',
    'polish.prompt':
        '请润色以下文本，保持原意的同时使表达更加流畅、专业。注意这是笔记"${noteTitle}"中的内容，上下文为：\n${noteContext}\n\n需要润色的文本：\n${text}\n\n请直接返回润色后的文本，不要添加任何解释或标记。',
    'polish.untitledNote': '无标题',
    'renderer.tool.listCurrentNotes.description': '获取当前界面中显示的所有笔记的标题和摘要',

    // ========== 错误 ==========
    'error.noteNotFound': '笔记 ${id} 不存在',
    'error.tagNotFound': '标签 ${name} 不存在',
    'error.deletedNoteNotFound': '回收站中不存在笔记 ${id}',

    // ========== Renderer：主界面 ==========
    'renderer.note.new': '新建',
    'renderer.note.search.placeholder': '搜索笔记...',
    'renderer.note.sort.updatedAt': '最近修改',
    'renderer.note.sort.createdAt': '最近创建',
    'renderer.note.sort.title': '按标题',
    'renderer.note.tag.all': '全部标签',
    'renderer.note.deleted.entry': '已删除',
    'renderer.note.count.notes': '${count} 条笔记',
    'renderer.note.count.notesShort': '${count} 条',
    'renderer.note.group.pinned': '置顶',
    'renderer.note.group.today': '今天',
    'renderer.note.group.yesterday': '昨天',
    'renderer.note.allNotes': '全部笔记',
    'renderer.note.empty.noNotes': '暂无笔记',
    'renderer.note.empty.createFirst': '点击"新建"创建第一条笔记',
    'renderer.note.untitled': '无标题',

    // ========== Renderer：编辑视图 ==========
    'renderer.note.editor.back': '返回',
    'renderer.note.pin.pinned': '已置顶',
    'renderer.note.pin.unpinned': '置顶',
    'renderer.note.delete': '删除',
    'renderer.note.rename': '重命名',
    'renderer.note.title.placeholder': '笔记标题',
    'renderer.note.tag.add': '标签',

    // ========== Renderer：格式工具栏 ==========
    'renderer.note.color.title': '文字颜色',
    'renderer.note.color.custom': '自定义颜色',
    'renderer.note.color.default': '默认',
    'renderer.note.color.red': '红色',
    'renderer.note.color.orange': '橙色',
    'renderer.note.color.yellow': '黄色',
    'renderer.note.color.green': '绿色',
    'renderer.note.color.blue': '蓝色',
    'renderer.note.color.purple': '紫色',
    'renderer.note.color.pink': '粉色',
    'renderer.note.color.gray': '灰色',
    'renderer.note.undo': '撤销',
    'renderer.note.redo': '重做',
    'renderer.note.bold': '粗体',
    'renderer.note.italic': '斜体',
    'renderer.note.underline': '下划线',
    'renderer.note.strikethrough': '删除线',
    'renderer.note.heading1': '标题 1',
    'renderer.note.heading2': '标题 2',
    'renderer.note.heading3': '标题 3',
    'renderer.note.heading4': '标题 4',
    'renderer.note.heading5': '标题 5',
    'renderer.note.heading6': '标题 6',
    'renderer.note.body': '正文',
    'renderer.note.list.bullet': '无序列表',
    'renderer.note.list.numbered': '有序列表',
    'renderer.note.align.left': '左对齐',
    'renderer.note.align.center': '居中',
    'renderer.note.align.right': '右对齐',
    'renderer.note.blockquote': '引用',
    'renderer.note.link': '链接',
    'renderer.note.image': '图片',
    'renderer.note.code': '源代码',
    'renderer.note.codeblock': '代码块',
    'renderer.note.codeblock.langHint': '语言（如 python）',
    'renderer.note.menu.cut': '剪切',
    'renderer.note.menu.copy': '复制',
    'renderer.note.menu.paste': '粘贴',
    'renderer.note.menu.pastePlain': '粘贴为纯文本',
    'renderer.note.menu.selectAll': '全选',
    'renderer.note.style.menu': '样式',

    // ========== Renderer：AI 润色 ==========
    'renderer.note.ai.polishTitle': 'AI 润色',
    'renderer.note.ai.selection': '润色选中',
    'renderer.note.ai.all': '润色全文',
    'renderer.note.ai.running': '正在润色...',
    'renderer.note.ai.assistant': 'AI 助手',
    'renderer.note.ai.trigger': '帮我',
    'renderer.note.ai.polish': '润色',
    'renderer.note.ai.translate': '翻译（即将推出）',
    'renderer.note.ai.execute': '执行',

    // ========== Renderer：标签菜单 ==========
    'renderer.note.tag.menu.title': '选择标签',
    'renderer.note.tag.delete': '删除标签',
    'renderer.note.tag.new.placeholder': '新建标签...',
    'renderer.note.tag.add.button': '添加',
    'renderer.note.tag.delete.confirm.title': '删除标签',
    'renderer.note.tag.delete.confirm.message': '确定要删除标签"${name}"吗？该标签将从所有笔记中移除。',

    // ========== Renderer：删除 / 回收站 ==========
    'renderer.note.note.delete.confirm.title': '删除笔记',
    'renderer.note.note.delete.confirm.message':
        '确定要删除笔记「${name}」吗？删除后可在回收站中恢复，10天后将永久删除。',
    'renderer.note.deleted.empty': '回收站为空',
    'renderer.note.deleted.clear': '清空回收站',
    'renderer.note.deleted.hint': '笔记删除后10天内可恢复',
    'renderer.note.deleted.deletedAt': '删除于 ${time}',
    'renderer.note.deleted.remaining': '${days}天后永久删除',
    'renderer.note.restore': '恢复',
    'renderer.note.delete.permanent': '永久删除',
    'renderer.note.permanent.confirm.message': '确定要永久删除这条笔记吗？此操作无法撤销。',
    'renderer.note.clear.confirm.message': '确定要永久删除回收站中的所有 ${count} 条笔记吗？此操作无法撤销。',
    'renderer.note.clear.confirm.button': '清空',

    // ========== Renderer：通用 ==========
    'renderer.note.common.cancel': '取消',
    'renderer.note.common.delete': '删除',

    // ========== Renderer：相对时间 ==========
    'renderer.note.time.justNow': '刚刚',
    'renderer.note.time.minutesAgo': '${n}分钟前',
    'renderer.note.time.hoursAgo': '${n}小时前',
    'renderer.note.time.daysAgo': '${n}天前'
};
