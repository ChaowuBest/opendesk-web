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
import { t } from './locale/index.js';
import { BaseToolset } from '../../aikernel/tool';
import { Skill } from '../../aikernel/skill.js';
import { LLM } from '../../aikernel/llm.js';
import NotesWorker from './service/worker';
import { CreateNoteTool, EditNoteTool, ReadNoteTool, ListNotesTool, ListTagsTool, DeleteNotesTool } from './tools';
import { NOTES_SKILL } from './skills';

class NotesApplication extends BaseApplication {
    constructor() {
        super('notes');
    }

    getName() {
        return t('app.name');
    }

    static getWorkerClass() {
        return NotesWorker;
    }

    async getSupportedEvents() {
        return [
            { eventName: 'notesChanged', eventDescription: t('appEvent.notesChanged') },
            { eventName: 'tagsChanged', eventDescription: t('appEvent.tagsChanged') },
            { eventName: 'deletedNotesChanged', eventDescription: t('appEvent.deletedNotesChanged') }
        ];
    }

    async polishText(text, noteTitle, noteContext) {
        const prompt = t('polish.prompt', {
            noteTitle: noteTitle || t('polish.untitledNote'),
            noteContext: noteContext || '',
            text
        });
        return await LLM.ask(prompt);
    }

    async getSkills() {
        const skill = Skill.parseMd(NOTES_SKILL);
        const toolset = new BaseToolset('notes');
        toolset.addTool(new CreateNoteTool(this));
        toolset.addTool(new EditNoteTool(this));
        toolset.addTool(new ReadNoteTool(this));
        toolset.addTool(new ListNotesTool(this));
        toolset.addTool(new ListTagsTool(this));
        toolset.addTool(new DeleteNotesTool(this));
        skill.toolsets = [toolset];
        return [skill];
    }
}

export { NotesApplication };
