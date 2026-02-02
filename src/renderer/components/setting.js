class SettingEditor extends HTMLElement {

    constructor() {
        super();
    }

    connectedCallback() {
        (async () => {
            this.render();
            await this.loadSettingSchema();
            await this.loadSettingData();
            this.setUpEventListeners();
        })()
    }

    async loadSettingSchema() {
        let schema = await window.settingAPI.loadSettingSchema()
        console.log(schema);
        this.querySelector('#setting-schema-editor').setSchema(schema);
    }

    async loadSettingData() {
        let data = await window.settingAPI.loadSettingObject()
        console.info('load setting data', data);
        this.querySelector('#setting-schema-editor').setValue(data);
    }

    saveSettingData() {
        let data = this.querySelector('#setting-schema-editor').getValue();
        window.settingAPI.saveSettingObject(data).then(async () => {
            await this.loadSettingData();
            window.notificationAPI.sendNotification('info', '设置', '保存成功', '设置已成功保存');
        }).catch(error => {
            window.notificationAPI.sendNotification('error', '设置', '保存失败', error.message);
        });
    }

    async exportSettingData() {
        let data = this.querySelector('#setting-schema-editor').getValue();

        // 弹窗让用户选择保存到哪儿
        try {
            const opts = {
                suggestedName: 'setting.json',
                types: [
                    {
                        description: 'JSON 文件',
                        accept: {'application/json': ['.json']},
                    },
                ],
            };
            const handle = await window.showSaveFilePicker(opts);
            const writable = await handle.createWritable();
            await writable.write(JSON.stringify(data, null, 2));
            await writable.close();
        } catch (err) {
            if (err.name !== 'AbortError') {
                this.querySelector('#setting-error-msg').innerHTML = `<span class="text-red-500">${err.message}</span>`;
            }
        }

        window.settingAPI.exportSettingData(data).then(async () => {
            this.querySelector('#setting-error-msg').innerHTML = '';
            this.querySelector('#setting-error-msg').innerHTML = '<span class="text-green-500">导出成功</span>';
        });
    }

    async importSettingData() {
        try {
            // 弹出文件选择对话框，只允许选择json文件
            const [fileHandle] = await window.showOpenFilePicker({
                types: [
                    {
                        description: 'JSON 文件',
                        accept: { 'application/json': ['.json'] },
                    },
                ],
                multiple: false
            });
            if (!fileHandle) return;

            const file = await fileHandle.getFile();
            const text = await file.text();
            let jsonData;

            try {
                jsonData = JSON.parse(text);
            } catch (err) {
                this.querySelector('#setting-error-msg').innerHTML = `<span class="text-red-500">文件内容不是有效的JSON：${err.message}</span>`;
                return;
            }

            // 保存设置
            window.settingAPI.saveSettingObject(jsonData).then(async () => {
                await this.loadSettingData();
                this.querySelector('#setting-error-msg').innerHTML = '';
                this.querySelector('#setting-error-msg').innerHTML = '<span class="text-green-500">导入并保存成功</span>';
            }).catch(error => {
                this.querySelector('#setting-error-msg').innerHTML = `<span class="text-red-500">${error.message}</span>`;
            });

        } catch (err) {
            if (err.name !== 'AbortError') {
                this.querySelector('#setting-error-msg').innerHTML = `<span class="text-red-500">${err.message}</span>`;
            }
        }
    }

    setUpEventListeners() {
        this.querySelector('#save-setting-btn').addEventListener('click', () => {
            this.saveSettingData();
        });
        this.querySelector('#export-setting-btn').addEventListener('click', () => {
            this.exportSettingData();
        });
        this.querySelector('#import-setting-btn').addEventListener('click', () => {
            this.importSettingData();
        });
    }

    render() {
        this.innerHTML = `
        <div class="flex flex-col h-full w-full p-5 bg-white">
            <!-- 标题 -->
            <div class="mb-4 pr-[120px] flex items-center justify-between">
                <h2 class="text-2xl font-bold text-gray-800">设置</h2>
                <!-- 按钮区域在右侧，按钮为浅色背景，hover 时优雅特效 -->
                <div class="space-x-2 flex text-xs">
                    <button
                        id="save-setting-btn"
                        class="px-4 py-2 rounded-full bg-white text-[#C94C40] border border-[#C94C40] shadow-sm hover:bg-[#C94C40] hover:text-white hover:shadow-lg transition-colors duration-200"
                    >保存设置</button>
                    <button
                        id="export-setting-btn"
                        class="px-4 py-2 rounded-full bg-white text-[#2D2D2D] border border-[#D1D5DB] shadow-sm hover:bg-[#ECECEC] hover:shadow-md transition-colors duration-200"
                    >导出设置</button>
                    <button
                        id="import-setting-btn"
                        class="px-4 py-2 rounded-full bg-white text-[#2D2D2D] border border-[#D1D5DB] shadow-sm hover:bg-[#ECECEC] hover:shadow-md transition-colors duration-200"
                    >导入设置</button>
                </div>
            </div>
            <!-- 主体内容部分 -->
            <div class="flex-1 h-full flex flex-col overflow-y-auto">
                <div class="flex items-center justify-between p-2">
                </div>
                <schema-editor
                    id="setting-schema-editor"
                    class="w-full flex-1"
                ></schema-editor>
            </div>
            <!-- 错误信息 -->
            <div id="setting-error-msg" class="min-h-[1.5em] text-sm"></div>
        </div>
        `
    }

}

customElements.define("setting-editor", SettingEditor)