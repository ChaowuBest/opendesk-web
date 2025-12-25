class SchemaEditor extends HTMLElement {
    constructor() {
        super();
        this.jsonSchema = null;
        this.currentValue = {};
        this.fieldIdCounter = 0;
    }

    connectedCallback() {
        this.render();
    }

    /**
     *
     * @param {object} jsonSchema - JSON Schema 对象
     */
    setSchema(jsonSchema) {
        this.jsonSchema = jsonSchema;
        this.currentValue = {};
        this.render();
    }

    /**
     * 设置编辑器中正在编辑的对象的值
     * @param {object} value
     */
    setValue(value) {
        this.currentValue = value || {};
        // 如果已经渲染，更新现有输入的值
        this.render();
    }

    /**
     * 获取编辑器中正在编辑的对象的值
     * @returns {object}
     */
    getValue() {
        return this.collectValue(this);
    }

    /**
     * 渲染编辑器
     */
    render() {
        if (!this.jsonSchema) {
            this.innerHTML = '<div class="p-4 text-gray-500">请先设置 Schema</div>';
            return;
        }

        // 创建 shadow DOM 或直接使用 innerHTML
        const container = document.createElement('div');
        container.className = 'schema-editor p-4';

        const editorContent = this.renderFromJSONSchema(this.jsonSchema, this.currentValue, '');
        container.innerHTML = editorContent;

        // 设置事件监听器
        this.setupEventListeners(container);

        this.innerHTML = '';
        this.appendChild(container);
    }

    /**
     * 设置事件监听器
     */
    setupEventListeners(container) {
        // 处理输入变化
        container.querySelectorAll('input, textarea, select').forEach(input => {
            input.addEventListener('input', () => {
                this.dispatchEvent(new CustomEvent('value-change', {
                    detail: { value: this.getValue() }
                }));
            });
            input.addEventListener('change', () => {
                this.dispatchEvent(new CustomEvent('value-change', {
                    detail: { value: this.getValue() }
                }));
            });
        });

        // 处理数组添加按钮
        container.querySelectorAll('[data-array-add-btn]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const fieldId = e.target.getAttribute('data-array-field-id');
                const fieldPath = e.target.getAttribute('data-field-path');
                const itemsSchema = JSON.parse(e.target.getAttribute('data-items-schema'));
                this.addArrayItem(fieldId, fieldPath, itemsSchema);
            });
        });

        // 处理可选字段的添加/移除
        container.querySelectorAll('[data-optional-toggle]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // 使用 currentTarget 或 closest 确保获取到按钮元素，而不是子元素
                const button = e.currentTarget || e.target.closest('[data-optional-toggle]');
                if (!button) return;

                const toggleId = button.getAttribute('data-toggle-id');
                const containerId = button.getAttribute('data-container-id');
                const fieldPath = button.getAttribute('data-field-path');
                const isAdding = button.getAttribute('data-action') === 'add';

                if (isAdding) {
                    const toggleEl = this.querySelector(`#${toggleId}`);
                    const containerEl = this.querySelector(`#${containerId}`);
                    if (toggleEl && containerEl) {
                        // 获取schema信息
                        const schemaJson = button.getAttribute('data-schema');
                        if (schemaJson) {
                            try {
                                const schema = JSON.parse(schemaJson);
                                // 如果有default值，应用到currentValue
                                if (schema.default !== undefined) {
                                    this.setNestedValue(this.currentValue, fieldPath, schema.default);
                                    // 更新输入框的值以反映default值
                                    this.updateInputValues(this.currentValue);
                                }
                            } catch (e) {
                                console.error('Failed to parse schema:', e);
                            }
                        }

                        toggleEl.style.display = 'none';
                        containerEl.style.display = 'block';

                        // 为新显示的字段设置事件监听器
                        this.setupEventListeners(containerEl);
                    }
                } else {
                    const toggleEl = this.querySelector(`#${toggleId}`);
                    const containerEl = this.querySelector(`#${containerId}`);
                    if (toggleEl && containerEl) {
                        containerEl.style.display = 'none';
                        toggleEl.style.display = 'flex';
                        // 从currentValue中移除该字段
                        if (fieldPath) {
                            this.removeNestedValue(this.currentValue, fieldPath);
                        }
                        // 清空字段值
                        const inputs = containerEl.querySelectorAll('input, textarea, select');
                        inputs.forEach(input => {
                            if (input.type === 'checkbox') {
                                input.checked = false;
                            } else {
                                input.value = '';
                            }
                        });
                    }
                }

                // 触发值变化事件
                this.dispatchEvent(new CustomEvent('value-change', {
                    detail: { value: this.getValue() }
                }));
            });
        });

        // 处理数组项删除
        container.querySelectorAll('[data-array-item-remove]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.target.closest('[data-array-index]').remove();
                this.dispatchEvent(new CustomEvent('value-change', {
                    detail: { value: this.getValue() }
                }));
            });
        });
    }

    /**
     * 添加数组项
     */
    addArrayItem(fieldId, fieldPath, itemsSchema) {
        const arrayContainer = this.querySelector(`[data-array-field="${fieldId}"]`);
        if (!arrayContainer) return;

        const itemsContainer = arrayContainer.querySelector('.space-y-2') || arrayContainer;
        const currentItems = itemsContainer.querySelectorAll('[data-array-index]');
        const index = currentItems.length;
        const itemPath = fieldPath ? `${fieldPath}[${index}]` : `${fieldId}[${index}]`;

        // 获取默认值（如果有）
        let defaultValue = undefined;
        if (itemsSchema.default !== undefined) {
            defaultValue = itemsSchema.default;
        } else if (itemsSchema.type === 'object' && itemsSchema.properties) {
            // 对于 object 类型，收集所有字段的默认值
            defaultValue = this.getObjectDefaultValue(itemsSchema);
        }

        const itemHtml = this.renderFromJSONSchema(itemsSchema, defaultValue, itemPath);
        const itemDiv = document.createElement('div');
        itemDiv.className = 'mb-3 p-3 border border-gray-200 rounded-md';
        itemDiv.setAttribute('data-array-index', index);
        itemDiv.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <span class="text-xs text-gray-500">项目 ${index + 1}</span>
                <button type="button" class="text-red-500 hover:text-red-700 text-xs" data-array-item-remove>删除</button>
            </div>
            ${itemHtml}
        `;

        itemsContainer.appendChild(itemDiv);
        this.setupEventListeners(itemDiv);

        // 如果有默认值，应用到 currentValue
        if (defaultValue !== undefined) {
            this.setNestedValue(this.currentValue, itemPath, defaultValue);
            // 更新输入框的值以反映默认值
            this.updateInputValues(this.currentValue);
        }

        this.dispatchEvent(new CustomEvent('value-change', {
            detail: { value: this.getValue() }
        }));
    }

    /**
     * 获取 object schema 的默认值
     */
    getObjectDefaultValue(jsonSchema) {
        if (!jsonSchema || jsonSchema.type !== 'object' || !jsonSchema.properties) {
            return undefined;
        }

        const result = {};
        const properties = jsonSchema.properties;
        const required = jsonSchema.required || [];

        for (const [key, propertySchema] of Object.entries(properties)) {
            // 如果字段有 default 值，使用它
            if (propertySchema.default !== undefined) {
                result[key] = propertySchema.default;
            } else if (propertySchema.type === 'object' && propertySchema.properties) {
                // 递归处理嵌套对象
                const nestedDefault = this.getObjectDefaultValue(propertySchema);
                if (nestedDefault !== undefined && Object.keys(nestedDefault).length > 0) {
                    result[key] = nestedDefault;
                }
            } else if (propertySchema.type === 'array' && propertySchema.items) {
                // 对于数组，如果有 default 值就使用，否则使用空数组
                if (propertySchema.default !== undefined) {
                    result[key] = propertySchema.default;
                } else if (required.includes(key)) {
                    // required 数组字段，使用空数组作为默认值
                    result[key] = [];
                }
            }
            // 注意：对于 optional 字段且没有 default 值的情况，不添加到结果中
        }

        return Object.keys(result).length > 0 ? result : undefined;
    }

    /**
     * 基于 JSON Schema 渲染表单字段
     */
    renderFromJSONSchema(jsonSchema, value, fieldPath) {
        if (!jsonSchema) {
            return '';
        }

        // 处理 anyOf/oneOf
        if (jsonSchema.anyOf) {
            const nonNullSchema = jsonSchema.anyOf.find(s => s.type !== 'null' && s.type !== undefined);
            if (nonNullSchema) {
                return this.renderFromJSONSchema(nonNullSchema, value, fieldPath);
            }
        }

        if (jsonSchema.oneOf) {
            const nonNullSchema = jsonSchema.oneOf.find(s => s.type !== 'null' && s.type !== undefined);
            if (nonNullSchema) {
                return this.renderFromJSONSchema(nonNullSchema, value, fieldPath);
            }
        }

        const type = jsonSchema.type;
        const actualType = Array.isArray(type) ? type.find(t => t !== 'null') : type;

        switch (actualType) {
            case 'string':
                return this.renderStringField(jsonSchema, value, fieldPath);
            case 'number':
            case 'integer':
                return this.renderNumberField(jsonSchema, value, fieldPath);
            case 'boolean':
                return this.renderBooleanField(jsonSchema, value, fieldPath);
            case 'object':
                return this.renderObjectFields(jsonSchema, value, fieldPath);
            case 'array':
                return this.renderArrayField(jsonSchema, value, fieldPath);
            default:
                return this.renderStringField(jsonSchema, value, fieldPath);
        }
    }

    /**
     * 渲染字符串字段
     */
    renderStringField(jsonSchema, value, fieldPath) {
        const fieldName = jsonSchema.title || fieldPath || '文本';
        const description = jsonSchema.description || '';
        const fieldId = this.generateFieldId();
        const nameAttr = fieldPath || fieldId;
        const safeValue = value !== undefined ? this.escapeHtml(String(value)) : '';
        const descriptionHtml = this.renderDescription(description);

        // 检查是否是枚举类型
        if (jsonSchema.enum && jsonSchema.enum.length > 0) {
            return this.renderEnumField(jsonSchema, value, fieldPath);
        }

        // 检查是否是文本域
        const isTextarea = jsonSchema.format === 'textarea' ||
                          (jsonSchema.maxLength && jsonSchema.maxLength > 100);

        const widgetHtml = isTextarea
            ? `<textarea
                id="${fieldId}"
                name="${nameAttr}"
                data-field-path="${fieldPath}"
                rows="4"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >${safeValue}</textarea>`
            : `<input
                type="text"
                id="${fieldId}"
                name="${nameAttr}"
                data-field-path="${fieldPath}"
                value="${safeValue}"
                class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />`;

        return `
            <div class="mb-4">
                <!-- <label for="${fieldId}" class="block text-sm font-medium text-gray-700 mb-1">${this.escapeHtml(fieldName)}</label> -->
                ${descriptionHtml}
                ${widgetHtml}
            </div>
        `;
    }

    /**
     * 渲染数字字段
     */
    renderNumberField(jsonSchema, value, fieldPath) {
        const fieldName = jsonSchema.title || fieldPath || '数字';
        const description = jsonSchema.description || '';
        const fieldId = this.generateFieldId();
        const nameAttr = fieldPath || fieldId;
        const safeValue = value !== undefined ? this.escapeHtml(String(value)) : '';
        const inputType = jsonSchema.type === 'integer' ? 'number' : 'number';
        const step = jsonSchema.type === 'integer' ? '1' : 'any';
        const descriptionHtml = this.renderDescription(description);

        let extraAttrs = '';
        if (jsonSchema.minimum !== undefined) {
            extraAttrs += ` min="${jsonSchema.minimum}"`;
        }
        if (jsonSchema.maximum !== undefined) {
            extraAttrs += ` max="${jsonSchema.maximum}"`;
        }

        return `
            <div class="mb-4">
                <label for="${fieldId}" class="block text-sm font-medium text-gray-700 mb-1">${this.escapeHtml(fieldName)}</label>
                ${descriptionHtml}
                <input
                    type="${inputType}"
                    id="${fieldId}"
                    name="${nameAttr}"
                    data-field-path="${fieldPath}"
                    value="${safeValue}"
                    step="${step}"
                    ${extraAttrs}
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
            </div>
        `;
    }

    /**
     * 渲染布尔字段
     */
    renderBooleanField(jsonSchema, value, fieldPath) {
        const fieldName = jsonSchema.title || fieldPath || '布尔值';
        const description = jsonSchema.description || '';
        const fieldId = this.generateFieldId();
        const nameAttr = fieldPath || fieldId;
        const checkedValue = value !== undefined ? value : (jsonSchema.default !== undefined ? jsonSchema.default : false);
        const checked = checkedValue === true ? 'checked' : '';
        const descriptionHtml = this.renderDescription(description);

        return `
            <div class="mb-4">
                <label class="flex items-center">
                    <input
                        type="checkbox"
                        id="${fieldId}"
                        name="${nameAttr}"
                        data-field-path="${fieldPath}"
                        ${checked}
                        class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <span class="ml-2 text-sm font-medium text-gray-700">${this.escapeHtml(fieldName)} ${descriptionHtml}</span>
                </label>
            </div>
        `;
    }

    /**
     * 渲染枚举字段
     */
    renderEnumField(jsonSchema, value, fieldPath) {
        const fieldName = jsonSchema.title || fieldPath || '选择';
        const description = jsonSchema.description || '';
        const fieldId = this.generateFieldId();
        const nameAttr = fieldPath || fieldId;
        const options = jsonSchema.enum || [];
        const descriptionHtml = this.renderDescription(description);

        let optionsHtml = options.map(opt => {
            const optValue = this.escapeHtml(String(opt));
            const selected = value === opt ? 'selected' : '';
            return `<option value="${optValue}" ${selected}>${optValue}</option>`;
        }).join('');

        return `
            <div class="mb-4">
                <label for="${fieldId}" class="block text-sm font-medium text-gray-700 mb-1">${this.escapeHtml(fieldName)}</label>
                ${descriptionHtml}
                <select
                    id="${fieldId}"
                    name="${nameAttr}"
                    data-field-path="${fieldPath}"
                    class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                    ${optionsHtml}
                </select>
            </div>
        `;
    }

    /**
     * 渲染对象字段
     */
    renderObjectFields(jsonSchema, value, fieldPath) {
        const properties = jsonSchema.properties || {};
        const required = jsonSchema.required || [];
        const description = jsonSchema.description || '';
        const fields = [];
        const descriptionHtml = description ? `<div class="mb-3">${this.renderDescription(description)}</div>` : '';

        for (const [key, propertySchema] of Object.entries(properties)) {
            let fieldValue = value && value[key] !== undefined ? value[key] : undefined;
            const currentPath = fieldPath ? `${fieldPath}.${key}` : key;

            const isOptional = this.isOptionalField(propertySchema, required, key);
            const fieldName = propertySchema.title || key;
            const isRequired = required.includes(key);
            const requiredMark = isRequired ? '<span class="text-red-500 ml-1">*</span>' : '';

            // 如果值为 undefined 且有 default 值，使用 default 值
            if (fieldValue === undefined && propertySchema.default !== undefined) {
                fieldValue = propertySchema.default;
            }

            if (isOptional && fieldValue === undefined) {
                const toggleId = this.generateFieldId();
                const fieldContainerId = this.generateFieldId();
                // 使用default值（如果有）来渲染字段
                const defaultValue = propertySchema.default !== undefined ? propertySchema.default : undefined;
                const fieldHtml = this.renderFromJSONSchema(propertySchema, defaultValue, currentPath);
                // 保存schema信息到data属性，以便在点击时访问
                const schemaJson = this.escapeHtml(JSON.stringify(propertySchema));

                fields.push(`
                    <div class="mb-4" data-field-key="${this.escapeHtml(key)}" data-optional="true">
                        <div id="${toggleId}" class="flex items-center">
                            <button
                                type="button"
                                data-optional-toggle
                                data-toggle-id="${toggleId}"
                                data-container-id="${fieldContainerId}"
                                data-field-path="${currentPath}"
                                data-schema="${schemaJson}"
                                data-action="add"
                                class="flex items-center text-sm text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                            >
                                <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                                </svg>
                                <span>配置 ${this.escapeHtml(fieldName)}</span>
                            </button>
                        </div>
                        <div id="${fieldContainerId}" style="display: none;">
                            <label class="block text-sm font-semibold text-gray-800 mb-2">
                                ${this.escapeHtml(fieldName)}${requiredMark}
                            </label>
                            <div class="ml-4">
                                ${fieldHtml}
                            </div>
                            <button
                                type="button"
                                data-optional-toggle
                                data-toggle-id="${toggleId}"
                                data-container-id="${fieldContainerId}"
                                data-field-path="${currentPath}"
                                data-action="remove"
                                class="mt-2 text-xs text-gray-500 hover:text-gray-700"
                            >
                                移除
                            </button>
                        </div>
                    </div>
                `);
            } else {
                const fieldHtml = this.renderFromJSONSchema(propertySchema, fieldValue, currentPath);
                fields.push(`
                    <div class="mb-4" data-field-key="${this.escapeHtml(key)}">
                        <label class="block text-sm font-semibold text-gray-800 mb-2">
                            ${this.escapeHtml(fieldName)}${requiredMark}
                        </label>
                        <div class="ml-4">
                            ${fieldHtml}
                        </div>
                    </div>
                `);
            }
        }

        return descriptionHtml + fields.join('');
    }

    /**
     * 渲染数组字段
     */
    renderArrayField(jsonSchema, value, fieldPath) {
        const fieldName = jsonSchema.title || fieldPath || '数组';
        const description = jsonSchema.description || '';
        const fieldId = this.generateFieldId();
        const itemsSchema = jsonSchema.items;
        const arrayValue = Array.isArray(value) ? value : [];
        const descriptionHtml = this.renderDescription(description);

        if (!itemsSchema) {
            return `
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-2">${this.escapeHtml(fieldName)}</label>
                    ${descriptionHtml}
                    <p class="text-sm text-gray-500">数组项类型未定义</p>
                </div>
            `;
        }

        const itemsHtml = arrayValue.map((itemValue, index) => {
            const itemPath = fieldPath ? `${fieldPath}[${index}]` : `${fieldId}[${index}]`;
            const itemHtml = this.renderFromJSONSchema(itemsSchema, itemValue, itemPath);
            return `
                <div class="mb-3 p-3 border border-gray-200 rounded-md" data-array-index="${index}">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-xs text-gray-500">第 ${index + 1} 项</span>
                        <button type="button" class="text-red-500 hover:text-red-700 text-xs" data-array-item-remove>删除</button>
                    </div>
                    ${itemHtml}
                </div>
            `;
        }).join('');

        const itemsSchemaJson = this.escapeHtml(JSON.stringify(itemsSchema));
        const addButtonHtml = `
            <button
                type="button"
                class="mt-2 px-3 py-1 text-sm text-blue-600 border border-blue-600 rounded hover:bg-blue-50"
                data-array-add-btn
                data-array-field-id="${fieldId}"
                data-field-path="${fieldPath || fieldId}"
                data-items-schema="${itemsSchemaJson}"
            >
                + 添加新项
            </button>
        `;

        return `
            <div class="mb-4" data-array-field="${fieldId}" data-field-path="${fieldPath || fieldId}">
                <label class="block text-sm font-medium text-gray-700 mb-2">${this.escapeHtml(fieldName)}</label>
                ${descriptionHtml}
                <div class="space-y-2">
                    ${itemsHtml}
                </div>
                ${addButtonHtml}
            </div>
        `;
    }

    /**
     * 检查字段是否为可选
     */
    isOptionalField(propertySchema, required, key) {
        if (required.includes(key)) {
            return false;
        }

        if (propertySchema.anyOf) {
            const hasNull = propertySchema.anyOf.some(s => s.type === 'null');
            if (hasNull) {
                return true;
            }
        }

        if (propertySchema.oneOf) {
            const hasNull = propertySchema.oneOf.some(s => s.type === 'null');
            if (hasNull) {
                return true;
            }
        }

        if (Array.isArray(propertySchema.type) && propertySchema.type.includes('null')) {
            return true;
        }

        return true;
    }

    /**
     * 渲染字段描述
     */
    renderDescription(description) {
        if (!description || description.trim() === '') {
            return '';
        }
        return `<p class="text-xs text-gray-500 mb-1 mt-0">${this.escapeHtml(description)}</p>`;
    }

    /**
     * 生成唯一的字段 ID
     */
    generateFieldId() {
        return `schema-field-${this.fieldIdCounter++}`;
    }

    /**
     * HTML 转义
     */
    escapeHtml(text) {
        if (text === null || text === undefined) {
            return '';
        }
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return String(text).replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * 收集表单值
     */
    collectValue(container) {
        const result = {};
        const inputs = container.querySelectorAll('[data-field-path]');

        inputs.forEach(input => {
            const path = input.getAttribute('data-field-path');
            if (!path) return;

            // 检查字段是否是 optional 的
            const optionalField = input.closest('[data-optional="true"]');
            const isOptional = optionalField !== null;
            const isArray = input.closest('[data-array-field]') !== null;

            // 如果是 optional 字段，检查其容器是否可见（即是否被用户点击过"配置"按钮）
            if (isOptional && optionalField) {
                // 查找包含该输入框的字段容器
                // 字段容器是一个有 id 的 div，初始为 display: none，点击"配置"后变为 display: block
                const fieldContainer = input.closest('div[id]');
                if (fieldContainer && fieldContainer.id) {
                    // 检查字段容器的显示状态
                    // 如果容器是隐藏的（display: none），说明用户没有点击"配置"按钮，不应该收集该字段的值
                    const computedStyle = window.getComputedStyle(fieldContainer);
                    if (computedStyle.display === 'none') {
                        return;
                    }
                }
            }

            let value;
            if (input.type === 'checkbox') {
                value = input.checked;
            } else if (input.type === 'number') {
                value = input.value === '' ? undefined : Number(input.value);
            } else if (input.type === 'text') {
                // 对于字符串类型，如果是 optional 字段且值为空，返回 undefined
                value = input.value.trim();
                if (isOptional && value === '') {
                    value = undefined;
                }
            } else if (input.type === 'button') {
                // 对于按钮类型，不设置值
                return;
            } else if (isArray && !isOptional) {
                value = [];
            }


            // 如果是 optional 字段且值为 undefined，不设置该值
            if (isOptional && value === undefined) {
                return;
            }

            // console.log('set value', input.type, path, value);
            this.setNestedValue(result, path, value);
        });

        // 清理 optional 字段的空值（空数组、空对象）
        this.cleanupOptionalEmptyValues(result, container);

        return result;
    }

    /**
     * 清理 optional 字段的空值
     */
    cleanupOptionalEmptyValues(result, container) {
        // 获取所有 optional 字段容器
        const optionalFields = container.querySelectorAll('[data-optional="true"]');

        optionalFields.forEach(optionalField => {
            const fieldKey = optionalField.getAttribute('data-field-key');
            if (!fieldKey) return;

            // 获取该 optional 字段中的第一个输入框，以确定字段路径
            const firstInput = optionalField.querySelector('[data-field-path]');
            if (!firstInput) {
                // 如果没有输入框，可能是空数组或空对象，检查并删除
                if (result[fieldKey] !== undefined) {
                    const value = result[fieldKey];
                    if ((Array.isArray(value) && value.length === 0) ||
                        (typeof value === 'object' && value !== null && Object.keys(value).length === 0) ||
                        value === '') {
                        delete result[fieldKey];
                    }
                }
                return;
            }

            const path = firstInput.getAttribute('data-field-path');
            if (!path) return;

            // 如果路径就是 fieldKey，说明是顶层字段
            if (path === fieldKey) {
                const value = result[fieldKey];
                if (value !== undefined) {
                    if ((Array.isArray(value) && value.length === 0) ||
                        (typeof value === 'object' && value !== null && Object.keys(value).length === 0) ||
                        value === '') {
                        delete result[fieldKey];
                    }
                }
            } else {
                // 嵌套字段，使用完整路径
                const value = this.getNestedValue(result, path);
                if (value !== undefined) {
                    if ((Array.isArray(value) && value.length === 0) ||
                        (typeof value === 'object' && value !== null && Object.keys(value).length === 0) ||
                        value === '') {
                        // 提取基础路径（fieldKey对应的路径）
                        const pathParts = path.split('.');
                        const fieldKeyIndex = pathParts.indexOf(fieldKey);
                        if (fieldKeyIndex >= 0) {
                            const basePath = pathParts.slice(0, fieldKeyIndex + 1).join('.');
                            this.removeNestedValue(result, basePath);
                        }
                    }
                }
            }
        });
    }

    /**
     * 设置嵌套对象的值
     */
    setNestedValue(obj, path, value) {
        if (!path) return;

        // 处理路径，支持 "field[0].subfield" 这样的格式
        const parts = [];
        let current = '';
        let inBrackets = false;

        for (let i = 0; i < path.length; i++) {
            const char = path[i];
            if (char === '[') {
                if (current) {
                    parts.push(current);
                    current = '';
                }
                inBrackets = true;
            } else if (char === ']') {
                if (inBrackets && current) {
                    parts.push(parseInt(current));
                    current = '';
                }
                inBrackets = false;
            } else if (char === '.' && !inBrackets) {
                if (current) {
                    parts.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }
        if (current) {
            parts.push(current);
        }

        let currentObj = obj;
        console.info('set nested value', obj, parts, value);
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const nextPart = parts[i + 1];

            if (typeof nextPart === 'number') {
                // 下一个是数组索引
                if (!currentObj[part] || !Array.isArray(currentObj[part])) {
                    currentObj[part] = [];
                }
                currentObj = currentObj[part];
            } else {
                // 下一个是对象属性
                if (!currentObj[part] || typeof currentObj[part] !== 'object' || Array.isArray(currentObj[part])) {
                    currentObj[part] = {};
                }
                currentObj = currentObj[part];
            }
        }

        const lastPart = parts[parts.length - 1];
        if (typeof lastPart === 'number') {
            // 最后一个是数组索引
            if (!Array.isArray(currentObj)) {
                return; // 不应该发生
            }
            currentObj[lastPart] = value;
        } else {
            currentObj[lastPart] = value;
        }
    }

    /**
     * 从嵌套对象中移除值
     */
    removeNestedValue(obj, path) {
        if (!path) return;

        // 处理路径，支持 "field[0].subfield" 这样的格式
        const parts = [];
        let current = '';
        let inBrackets = false;

        for (let i = 0; i < path.length; i++) {
            const char = path[i];
            if (char === '[') {
                if (current) {
                    parts.push(current);
                    current = '';
                }
                inBrackets = true;
            } else if (char === ']') {
                if (inBrackets && current) {
                    parts.push(parseInt(current));
                    current = '';
                }
                inBrackets = false;
            } else if (char === '.' && !inBrackets) {
                if (current) {
                    parts.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }
        if (current) {
            parts.push(current);
        }

        if (parts.length === 0) return;

        let currentObj = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const nextPart = parts[i + 1];

            if (typeof nextPart === 'number') {
                // 下一个是数组索引
                if (!currentObj[part] || !Array.isArray(currentObj[part])) {
                    return; // 路径不存在
                }
                currentObj = currentObj[part];
            } else {
                // 下一个是对象属性
                if (!currentObj[part] || typeof currentObj[part] !== 'object' || Array.isArray(currentObj[part])) {
                    return; // 路径不存在
                }
                currentObj = currentObj[part];
            }
        }

        const lastPart = parts[parts.length - 1];
        if (typeof lastPart === 'number') {
            // 最后一个是数组索引
            if (!Array.isArray(currentObj)) {
                return; // 不应该发生
            }
            currentObj.splice(lastPart, 1);
        } else {
            delete currentObj[lastPart];
        }
    }

    /**
     * 从嵌套对象获取值
     */
    getNestedValue(obj, path) {
        if (!path) return undefined;

        const parts = [];
        let current = '';
        let inBrackets = false;

        for (let i = 0; i < path.length; i++) {
            const char = path[i];
            if (char === '[') {
                if (current) {
                    parts.push(current);
                    current = '';
                }
                inBrackets = true;
            } else if (char === ']') {
                if (inBrackets && current) {
                    parts.push(parseInt(current));
                    current = '';
                }
                inBrackets = false;
            } else if (char === '.' && !inBrackets) {
                if (current) {
                    parts.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }
        if (current) {
            parts.push(current);
        }

        let currentObj = obj;
        for (const part of parts) {
            if (currentObj === null || currentObj === undefined) {
                return undefined;
            }
            currentObj = currentObj[part];
        }
        return currentObj;
    }
}

customElements.define('schema-editor', SchemaEditor);