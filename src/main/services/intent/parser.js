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

import { desktopCapturer } from 'electron';
import { LLM } from '../../agents/llm.js';
import { UserMessage, ChatContext } from '../../aikernel/messages';
import { Setting } from '../../utils/setting.js';
import { IntentRegistry } from './intents.js';
import { z } from 'zod';


function buildIntentParsingPrompt(intents) {
    const intentList = intents.map(intent =>
        `- 意图名称: ${intent.name}\n` +
        `  * 意图描述: ${intent.description}\n` +
        `  * 意图的输入参数Schema: ${JSON.stringify(z.toJSONSchema(intent.params))}`
    ).join('\n');

    return `
你是一个熟悉手机和电脑操作的，善解人意的智能体，总是用中文回答用户的问题。

你需要通过用户给定的设备截图，来猜测用户接下来可能需要你帮忙执行的任务（我们称之为意图）。
当前所有支持的意图在下面列出：

## 当前系统中已经支持的可以执行的意图

${intentList}

## 返回格式

你的返回格式应该为JSON格式的数组，表示所有可能的意图。这些意图需要按照可能性由大到小排序，
数组中的每个元素应当符合下面的格式:

    {
        "name": <意图的名称>,
        "reasoning": <简短描述该意图与当前屏幕内容相关的原因，使用自然轻快的语气>,
        "confidence": <该意图的置信度，也就是可能性评分，范围从0到1>,
        "params": <意图的参数，需要与该意图的输入参数Schema匹配>
    }
`;
}

class IntentInstance {
    /**
     *
     * @param {string} name
     * @param {string} reasoning
     * @param {number} confidence
     * @param {object} params
     */
    constructor(name, reasoning, confidence, params) {
        /** @type {string} */
        this.name = name;
        /** @type {string} */
        this.reasoning = reasoning;
        /** @type {number} */
        this.confidence = confidence;
        /** @type {object} */
        this.params = params;
    }

    /**
     * Parse an intent instance from an object
     * @param {object} obj
     * @returns {IntentInstance}
     */
    static parse(obj) {
        return new IntentInstance(obj.name, obj.reasoning, obj.confidence, obj.params);
    }

    /**
     * Parse an array of intent instances
     * @param {object[]} array
     * @returns {IntentInstance[]}
     */
    static parseArray(array) {
        return array.map(item => IntentInstance.parse(item));
    }
}

class IntentParser {

    /**
     * Get the screenshot of the entire screen as a data URL
     * @returns {Promise<string>}
     */
    static async getScreenshotAsURL() {
        let sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
        // You may want to adjust the thumbnailSize to your requirements or get the system's screen size
        // Here, we pick the first screen (primary screen).
        if (sources.length > 0) {
            return sources[0].thumbnail.toDataURL()
        } else {
            throw new Error('No screen sources found');
        }
    }

    static getScreenParsingPrompt() {
        let intents = IntentRegistry.getInstance().getIntents()
        let prompt = buildIntentParsingPrompt(intents)
        // console.info(prompt)
        return prompt
    }

    /**
     * Parse the screen
     * @param {string | undefined} screenshotURL
     * @returns {Promise<IntentInstance[]>}
     */
    static async parseScreen(screenshotURL = undefined) {
        console.info('start parsing screen')
        if (screenshotURL === undefined) {
            screenshotURL = await this.getScreenshotAsURL()
        }
        let model = Setting.getInstance().getDefaultIntentParsingModelInstance();
        let question = new UserMessage()
            .appendText(IntentParser.getScreenParsingPrompt())
            .appendImageURL(screenshotURL);

        let resp = await LLM.askForObject(question, model);
        let intents = IntentInstance.parseArray(resp);
        console.info('parsed intents: ', intents);

        return intents;
    }
}

export { IntentParser };
