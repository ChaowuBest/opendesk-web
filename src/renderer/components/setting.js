class SettingEditor extends HTMLElement {

    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
        this.loadSettingData();
        this.setUpEventListeners();
    }

    loadSettingData() {
        window.settingAPI.loadSettingObject().then(data => {
            this.querySelector('#json-setting-editor').value = JSON.stringify(data, null, 4);
        });
    }

    saveSettingData() {
        let data = null;
        try {
            data = JSON.parse(this.querySelector('#json-setting-editor').value);
        } catch (error) {
            this.querySelector('#setting-error-msg').innerHTML = `<span class="text-red-500">${error.message}</span>`;
            return;
        }
        window.settingAPI.saveSettingObject(data).then(() => {
            this.querySelector('#setting-error-msg').innerHTML = '';
            this.loadSettingData();
            this.querySelector('#setting-error-msg').innerHTML = '<span class="text-green-500">保存成功</span>';
        }).catch(error => {
            this.querySelector('#setting-error-msg').innerHTML = `<span class="text-red-500">${error.message}</span>`;
        });
    }

    setUpEventListeners() {
        this.querySelector('#save-setting-btn').addEventListener('click', () => {
            this.saveSettingData();
        });
    }

    render() {
        this.innerHTML = `
        <div class="flex flex-col h-full w-full p-6 bg-white">
            <!-- 标题 -->
            <div class="mb-4">
                <h2 class="text-2xl font-bold text-gray-800">设置</h2>
            </div>
            <!-- 主体内容部分 -->
            <div class="flex-1 relative mb-4">
                <!-- 保存按钮 -->
                <button id="save-setting-btn" class="absolute top-6 right-6 px-4 py-2 bg-blue-600 text-white rounded shadow hover:bg-blue-700 z-10 transition-all">
                    保存
                </button>
                <!-- JSON 编辑器 -->
                <textarea id="json-setting-editor"
                    class="w-full h-full text-sm border border-gray-200 rounded-xl p-3 font-mono text-gray-800 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
                    placeholder="{&#10;  &quot;apiKey&quot;: &quot;sk-xxx...&quot;&#10;}"
                ></textarea>
            </div>
            <!-- 错误信息 -->
            <div id="setting-error-msg" class="min-h-[1.5em] text-sm"></div>
        </div>
        `
    }

}

customElements.define("setting-editor", SettingEditor)