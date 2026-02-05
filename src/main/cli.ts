import { intro, outro, text, note, spinner, box, select } from '@clack/prompts';
import { LLM } from './agents/llm.js';
import { GlobalState } from './states/global.js';
import { ChatContext, UserMessage } from './agents/messages.js';
import { argv } from 'process';
import cliMarkdown from 'cli-markdown';

// const state = GlobalState.getInstance();

async function main() {
    intro(`welcome to fillip desk cli`);
    var prompt = '';
    if (argv[2]) {
        prompt = argv[2];
    } else {
        prompt = await text({
            message: 'What do you want to do?',
            placeholder: 'I want to create a new project',
        }).then(result => result.toString());
    }
    const s = spinner();
    s.start('思考中...');
    const context = new ChatContext();
    context.appendMessage(new UserMessage(prompt.toString()));
    var i = 0;
    var response = '';
    for await (const message of LLM.streamComplete(context)) {
        i ++;
        s.message(`正在组织回答 (已产生 ${message.usage?.total_tokens} 词) `);
        response += message.content.content.map(part => (part as TextMessagePart).text).join('');
    }
    response = response.trim();
    s.stop('thinking finished')
    box(cliMarkdown(response), 'Response', { rounded: true, titleAlign: 'center' });
    select({
        message: '请选择是否继续',
        options: [
            { label: '继续', value: 'continue' },
            { label: '退出', value: 'exit' },
        ],
    }).then(result => {
        if (result === 'exit') {
            outro('感谢使用');
        } else {
            main();
        }
    })
}

main();