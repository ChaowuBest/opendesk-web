import { AssistantMessage } from './messages.js';


class Agent {
    execute(userMessage, chatCtx) {

    }
}

class BasicAgent extends Agent {
    execute(userMessage, chatCtx) {
        let new_msg = new AssistantMessage(userMessage.content)
        chatCtx.appendMessage(new_msg);
    }
}