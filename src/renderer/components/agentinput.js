class AgentInput extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
        this.setUpEventListeners();
    }

    disconnectedCallback() {

    }

    render() {
        this.innerHTML = `
        <div class="bg-white border border-gray-200 rounded-xl shadow-sm">
            <!-- 主要输入区域 -->
            <div class="p-3">
                <textarea
                    id="agent-input-textarea"
                    placeholder="在这里输入消息，按 Ctrl+Enter 发送"
                    class="w-full h-15 resize-none border-none outline-none placeholder-gray-400 text-gray-700"
                ></textarea>
            </div>

            <!-- 工具栏 -->
            <div class="flex items-center justify-between px-2 py-1 border-t border-gray-100">
                <!-- 左侧工具按钮 -->
                <div class="flex items-center space-x-3">
                    <!-- 附件 -->
                    <button class="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-md transition-colors">
                        <i class="fas fa-paperclip text-lg"></i>
                    </button>

                    <!-- 语音 -->
                    <button class="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-md transition-colors">
                        <i class="fas fa-microphone text-lg"></i>
                    </button>
                </div>

                <!-- 右侧按钮 -->
                <div class="flex items-center space-x-2">
                    <!-- 发送按钮 -->
                    <button id="agent-input-submit-btn" class="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-full transition-colors">
                        <i class="fas fa-arrow-up text-lg"></i>
                </div>
            </div>
        </div>
        `
    }

    setUpEventListeners() {
        const textarea = this.querySelector('#agent-input-textarea')
        const submitBtn = this.querySelector('#agent-input-submit-btn')

        // 提交消息的函数
        const handleSubmit = () => {
            const message = textarea.value.trim()
            if (message === '') {
                return;
            }

            const submitEvent = new CustomEvent('submit', {
                detail: {
                    message: message
                },
                bubbles: true
            });
            this.dispatchEvent(submitEvent);
            textarea.value = '';
        }

        // 按钮点击事件
        submitBtn.addEventListener('click', handleSubmit)

        // Ctrl+Enter 快捷键
        textarea.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
            }
        })

        textarea.addEventListener('input', (e) => {
            this.dispatchEvent(new CustomEvent('contentChanged', {
                detail: {
                    value: e.target.value
                },
                bubbles: true
            }));
        })
    }
}

customElements.define('agent-input', AgentInput)