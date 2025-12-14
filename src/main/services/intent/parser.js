const { desktopCapturer } = require('electron');
const { LLM } = require('../../agents/llm');
const { UserMessage, ChatContext } = require('../../agents/messages');
const fs = require('fs');


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

    static async parseScreen() {
        console.info('start parsing screen')
        let screenshot = await this.getScreenshotAsURL()
        let chat_context = new ChatContext();
        let user_message = new UserMessage(`The screenshot is of the entire screen. Explain the screen in detail.`)
        user_message.appendImageURL(screenshot)
        chat_context.appendMessage(user_message)
        for await (const response of LLM.complete(chat_context)) {
            console.info(response.content.content[0].text)
        }
    }
}

module.exports = { IntentParser };
