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

import { BaseApplication } from '../base';
import { BaseToolset } from '../../aikernel/tool';
import { Skill } from '../../aikernel/skill.js';
import { LLM } from '../../aikernel/llm.js';
import NotesWorker from './service/worker';
import { GetNotesTool, CreateNoteTool, UpdateNoteTool, DeleteNoteTool } from './tools';
import { NOTES_SKILL } from './skills';

class NotesApplication extends BaseApplication {
    constructor() {
        super('notes', '笔记');
    }

    static getWorkerClass() {
        return NotesWorker;
    }

    async getSupportedEvents() {
        return [
            { eventName: 'notesChanged', eventDescription: '笔记列表发生变化' },
            { eventName: 'tagsChanged', eventDescription: '标签列表发生变化' }
        ];
    }

    async polishText(text, noteTitle, noteContext) {
        const prompt = `请润色以下文本，保持原意的同时使表达更加流畅、专业。注意这是笔记"${noteTitle || '无标题'}"中的内容，上下文为：\n${noteContext || ''}\n\n需要润色的文本：\n${text}\n\n请直接返回润色后的文本，不要添加任何解释或标记。`;
        return await LLM.ask(prompt);
    }

    async getSkills() {
        const skill = Skill.parseMd(NOTES_SKILL);
        const toolset = new BaseToolset('notes');
        toolset.addTool(new GetNotesTool(this));
        toolset.addTool(new CreateNoteTool(this));
        toolset.addTool(new UpdateNoteTool(this));
        toolset.addTool(new DeleteNoteTool(this));
        skill.toolsets = [toolset];
        return [skill];
    }
}

export { NotesApplication };
