/**
 * A2UI 到 HTML 转换器
 * 将 Google A2UI 标准格式的文本/JSON 转换为 HTML
 */

class A2UIToHTMLConverter {
  constructor() {
    this.componentBuffers = {};  // surfaceId -> { id -> componentDef }
    this.dataModels = {};        // surfaceId -> data model object
    this.renderStyles = {};      // surfaceId -> beginRendering.styles
    this.renderRootId = null;
    this.renderSurfaceId = null;
  }

  /**
   * 处理 surfaceUpdate 消息
   */
  handleSurfaceUpdate(msg) {
    const { surfaceId, components } = msg.surfaceUpdate;
    if (!this.componentBuffers[surfaceId]) {
      this.componentBuffers[surfaceId] = {};
    }
    components.forEach(comp => {
      this.componentBuffers[surfaceId][comp.id] = comp.component;
    });
  }

  /**
   * 处理 dataModelUpdate 消息
   */
  handleDataModelUpdate(msg) {
    const { surfaceId, contents } = msg.dataModelUpdate;
    if (!this.dataModels[surfaceId]) {
      this.dataModels[surfaceId] = {};
    }
    contents.forEach(item => {
      let value = null;
      if (item.valueString !== undefined) {
        value = item.valueString;
      } else if (item.valueInt !== undefined) {
        value = item.valueInt;
      } else if (item.valueDouble !== undefined) {
        value = item.valueDouble;
      } else if (item.valueBool !== undefined) {
        value = item.valueBool;
      } else if (item.valueObject !== undefined) {
        value = item.valueObject;
      }
      this.dataModels[surfaceId][item.key] = value;
    });
  }

  /**
   * 处理 beginRendering 消息
   */
  handleBeginRendering(msg) {
    this.renderSurfaceId = msg.beginRendering.surfaceId;
    this.renderRootId = msg.beginRendering.root;
    if (msg.beginRendering.styles && this.renderSurfaceId) {
      this.renderStyles[this.renderSurfaceId] = msg.beginRendering.styles;
    }
  }

  /**
   * 处理 deleteSurface 消息
   */
  handleDeleteSurface(msg) {
    const { surfaceId } = msg.deleteSurface;
    delete this.componentBuffers[surfaceId];
    delete this.dataModels[surfaceId];
    delete this.renderStyles[surfaceId];
  }

  /**
   * 拼接 style 字符串（去掉多余分号，避免出现 ";;"）
   */
  mergeStyleStrings(...styleParts) {
    const parts = styleParts
      .filter(Boolean)
      .map(s => String(s).trim())
      .filter(Boolean)
      .map(s => (s.endsWith(';') ? s.slice(0, -1) : s));
    return parts.length ? parts.join('; ') : null;
  }

  /**
   * 从 props 里取 a2ui 常见的内联样式字段（你示例使用 style: "..."）
   */
  getInlineStyleFromProps(props) {
    if (!props) return null;
    if (typeof props.style === 'string') return props.style;
    if (typeof props.styles === 'string') return props.styles;
    if (typeof props.css === 'string') return props.css;
    return null;
  }

  /**
   * usageHint/variant 到 HTML tag 的简易映射（让你的示例更接近“标题/正文”）
   */
  pickTextTag(props) {
    const hint = props?.usageHint || props?.variant;
    if (!hint) return 'span';
    const h = String(hint).toLowerCase();
    if (h.startsWith('h')) return h.replace('.', ''); // "h." / "h1" 等
    if (h === 'body' || h === 'paragraph') return 'p';
    return 'span';
  }

  /**
   * 解析绑定值（支持 literal 和 path 绑定）
   */
  resolveBoundValue(boundVal, dataModel) {
    if (!boundVal || typeof boundVal !== 'object') {
      return boundVal;
    }

    // 处理 literal 值
    if (boundVal.literalString !== undefined) {
      return String(boundVal.literalString);
    }
    if (boundVal.literalInt !== undefined) {
      return boundVal.literalInt;
    }
    if (boundVal.literalDouble !== undefined) {
      return boundVal.literalDouble;
    }
    if (boundVal.literalBool !== undefined) {
      return boundVal.literalBool;
    }

    // 处理 path 绑定
    if (boundVal.path !== undefined) {
      const path = boundVal.path.replace(/^\//, '').split('/');
      let value = dataModel;
      for (const key of path) {
        if (value && typeof value === 'object' && key in value) {
          value = value[key];
        } else {
          return '';
        }
      }
      return value !== undefined ? value : '';
    }

    return '';
  }

  /**
   * 转义 HTML 特殊字符
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
   * 渲染单个组件
   */
  renderComponentById(id, compBuf, dataModel) {
    const compObj = compBuf[id];
    if (!compObj) {
      return '';
    }

    const keys = Object.keys(compObj);
    if (keys.length !== 1) {
      return '';
    }

    const type = keys[0];
    const props = compObj[type];

    switch (type) {
      case 'Text': {
        const textVal = this.resolveBoundValue(props.text, dataModel);
        const escapedText = this.escapeHtml(textVal);
        const tag = this.pickTextTag(props);
        const style = this.buildTextStyle(props);
        return `<${tag}${style ? ` style="${style}"` : ''}>${escapedText}</${tag}>`;
      }

      case 'Image': {
        const url = this.resolveBoundValue(props.url || props.src, dataModel);
        const alt = this.resolveBoundValue(props.alt, dataModel) || '';
        const style = this.buildImageStyle(props);
        return `<img src="${this.escapeHtml(url)}" alt="${this.escapeHtml(alt)}"${style ? ` style="${style}"` : ''} />`;
      }

      case 'Button': {
        const childId = props.child;
        const childHtml = childId ? this.renderComponentById(childId, compBuf, dataModel) : '';
        const style = this.buildButtonStyle(props);
        const disabled = props.disabled ? ' disabled' : '';
        return `<button${style ? ` style="${style}"` : ''}${disabled}>${childHtml}</button>`;
      }

      case 'Column': {
        const children = this.getChildren(props, compBuf, dataModel);
        const style = this.buildLayoutStyle(props, 'column');
        return `<div style="${style}">${children}</div>`;
      }

      case 'Row': {
        const children = this.getChildren(props, compBuf, dataModel);
        const style = this.buildLayoutStyle(props, 'row');
        return `<div style="${style}">${children}</div>`;
      }

      case 'Divider': {
        const axis = (props.axis || 'horizontal').toLowerCase();
        const base = axis === 'vertical'
          ? 'width: 1px; align-self: stretch; background: rgba(0,0,0,0.12); margin: 0 8px;'
          : 'height: 1px; width: 100%; background: rgba(0,0,0,0.12); margin: 12px 0;';
        const style = this.mergeStyleStrings(base, this.getInlineStyleFromProps(props));
        return `<div role="separator" aria-orientation="${axis === 'vertical' ? 'vertical' : 'horizontal'}"${style ? ` style="${style}"` : ''}></div>`;
      }

      case 'TextField': {
        const placeholder = this.resolveBoundValue(props.placeholder, dataModel) || '';
        const value = this.resolveBoundValue(props.value, dataModel) || '';
        const style = this.buildInputStyle(props);
        return `<input type="text" placeholder="${this.escapeHtml(placeholder)}" value="${this.escapeHtml(value)}"${style ? ` style="${style}"` : ''} />`;
      }

      case 'CheckBox': {
        const label = this.resolveBoundValue(props.label, dataModel) || '';
        const checked = props.checked ? ' checked' : '';
        return `<label><input type="checkbox"${checked} /> ${this.escapeHtml(label)}</label>`;
      }

      case 'Container':
      case 'Box': {
        const children = this.getChildren(props, compBuf, dataModel);
        const style = this.buildContainerStyle(props);
        return `<div${style ? ` style="${style}"` : ''}>${children}</div>`;
      }

      default:
        // 未知组件类型，尝试渲染为通用 div
        const defaultChildren = this.getChildren(props, compBuf, dataModel);
        return `<div class="a2ui-${type.toLowerCase()}">${defaultChildren}</div>`;
    }
  }

  /**
   * 获取子组件 HTML
   */
  getChildren(props, compBuf, dataModel) {
    if (props.children) {
      if (props.children.explicitList) {
        // 静态子组件列表
        return props.children.explicitList
          .map(childId => this.renderComponentById(childId, compBuf, dataModel))
          .join('');
      } else if (props.children.template) {
        // 动态模板（简化处理）
        const template = props.children.template;
        const listPath = template.listPath;
        if (listPath && dataModel) {
          const list = this.resolveBoundValue({ path: listPath }, dataModel);
          if (Array.isArray(list)) {
            return list
              .map((item, index) => {
                const childId = template.child;
                // 这里可以创建临时组件实例，简化处理
                return this.renderComponentById(childId, compBuf, dataModel);
              })
              .join('');
          }
        }
      }
    }
    if (props.child) {
      // 单个子组件
      return this.renderComponentById(props.child, compBuf, dataModel);
    }
    return '';
  }

  /**
   * 构建文本样式
   */
  buildTextStyle(props) {
    const styles = [];
    if (props.fontSize) {
      styles.push(`font-size: ${props.fontSize}px`);
    }
    if (props.fontWeight) {
      styles.push(`font-weight: ${props.fontWeight}`);
    }
    if (props.color) {
      styles.push(`color: ${props.color}`);
    }
    if (props.alignment) {
      styles.push(`text-align: ${props.alignment}`);
    }
    return this.mergeStyleStrings(styles.join('; '), this.getInlineStyleFromProps(props));
  }

  /**
   * 构建图片样式
   */
  buildImageStyle(props) {
    const styles = [];
    if (props.width) {
      styles.push(`width: ${props.width}px`);
    }
    if (props.height) {
      styles.push(`height: ${props.height}px`);
    }
    return this.mergeStyleStrings(styles.join('; '), this.getInlineStyleFromProps(props));
  }

  /**
   * 构建按钮样式
   */
  buildButtonStyle(props) {
    const styles = [];
    // primary button + theme 兜底（你的示例是 primary: true，并在 beginRendering.styles 里给 primaryColor）
    const theme = this.renderStyles?.[this.renderSurfaceId] || {};
    const primaryColor = theme.primaryColor || '#2563eb';
    if (props.primary) {
      styles.push(`background-color: ${primaryColor}`);
      styles.push(`color: #fff`);
      styles.push(`border: 1px solid ${primaryColor}`);
    }
    if (props.backgroundColor) {
      styles.push(`background-color: ${props.backgroundColor}`);
    }
    if (props.textColor) {
      styles.push(`color: ${props.textColor}`);
    }
    if (props.padding) {
      styles.push(`padding: ${props.padding}px`);
    }
    // 给一个更“组件化”的基础观感
    styles.push('border-radius: 10px');
    styles.push('padding: 10px 14px');
    styles.push('cursor: pointer');
    styles.push('font-size: 14px');
    styles.push('line-height: 1.2');
    styles.push('display: inline-flex');
    styles.push('align-items: center');
    styles.push('justify-content: center');

    return this.mergeStyleStrings(styles.join('; '), this.getInlineStyleFromProps(props));
  }

  mapFlexAlign(value) {
    if (!value) return null;
    const v = String(value).toLowerCase();
    if (v === 'start' || v === 'flex-start' || v === 'left' || v === 'top') return 'flex-start';
    if (v === 'end' || v === 'flex-end' || v === 'right' || v === 'bottom') return 'flex-end';
    if (v === 'center') return 'center';
    if (v === 'stretch') return 'stretch';
    if (v === 'spacebetween' || v === 'space-between') return 'space-between';
    if (v === 'spacearound' || v === 'space-around') return 'space-around';
    if (v === 'spaceevenly' || v === 'space-evenly') return 'space-evenly';
    return value;
  }

  /**
   * 构建布局样式
   */
  buildLayoutStyle(props, direction) {
    const styles = [`display: flex`, `flex-direction: ${direction}`];
    if (props.gap) {
      styles.push(`gap: ${props.gap}px`);
    }
    if (props.padding) {
      styles.push(`padding: ${props.padding}px`);
    }
    if (props.alignment) {
      styles.push(`align-items: ${this.mapFlexAlign(props.alignment)}`);
    }
    if (props.justification) {
      styles.push(`justify-content: ${this.mapFlexAlign(props.justification)}`);
    }
    return this.mergeStyleStrings(styles.join('; '), this.getInlineStyleFromProps(props)) || '';
  }

  /**
   * 构建容器样式
   */
  buildContainerStyle(props) {
    const styles = [];
    if (props.backgroundColor) {
      styles.push(`background-color: ${props.backgroundColor}`);
    }
    if (props.padding) {
      styles.push(`padding: ${props.padding}px`);
    }
    if (props.margin) {
      styles.push(`margin: ${props.margin}px`);
    }
    if (props.width) {
      styles.push(`width: ${props.width}px`);
    }
    if (props.height) {
      styles.push(`height: ${props.height}px`);
    }
    return this.mergeStyleStrings(styles.join('; '), this.getInlineStyleFromProps(props));
  }

  /**
   * 构建输入框样式
   */
  buildInputStyle(props) {
    const styles = [];
    if (props.width) {
      styles.push(`width: ${props.width}px`);
    }
    if (props.padding) {
      styles.push(`padding: ${props.padding}px`);
    }
    styles.push('border: 1px solid rgba(0,0,0,0.18)');
    styles.push('border-radius: 10px');
    styles.push('outline: none');
    styles.push('min-height: 36px');
    return this.mergeStyleStrings(styles.join('; '), this.getInlineStyleFromProps(props));
  }

  /**
   * 处理消息数组
   */
  processMessages(messages) {
    // 重置状态
    this.componentBuffers = {};
    this.dataModels = {};
    this.renderRootId = null;
    this.renderSurfaceId = null;

    // 处理每条消息
    messages.forEach(msg => {
      if (msg.surfaceUpdate) {
        this.handleSurfaceUpdate(msg);
      } else if (msg.dataModelUpdate) {
        this.handleDataModelUpdate(msg);
      } else if (msg.beginRendering) {
        this.handleBeginRendering(msg);
      } else if (msg.deleteSurface) {
        this.handleDeleteSurface(msg);
      }
    });

    // 如果没有收到 beginRendering，返回空字符串
    if (!this.renderRootId || !this.renderSurfaceId) {
      return '';
    }

    const compBuf = this.componentBuffers[this.renderSurfaceId];
    const dataModel = this.dataModels[this.renderSurfaceId] || {};
    const theme = this.renderStyles?.[this.renderSurfaceId] || {};

    if (!compBuf) {
      return '';
    }

    const rootHtml = this.renderComponentById(this.renderRootId, compBuf, dataModel);
    const rootStyle = this.mergeStyleStrings(
      theme.font ? `font-family: ${theme.font}, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif` : null,
      theme.primaryColor ? `--a2ui-primary-color: ${theme.primaryColor}` : null,
      'color: rgba(0,0,0,0.88)'
    );
    return `<div class="a2ui-root"${rootStyle ? ` style="${rootStyle}"` : ''}>${rootHtml}</div>`;
  }

  /**
   * 从 JSONL 文本（每行一个 JSON）解析并转换
   */
  convertFromJSONL(jsonlText) {
    const lines = jsonlText.trim().split('\n').filter(line => line.trim());
    const messages = lines.map(line => JSON.parse(line));
    return this.processMessages(messages);
  }

  /**
   * 从 JSON 数组转换
   */
  convertFromJSON(json) {
    const messages = Array.isArray(json) ? json : [json];
    return this.processMessages(messages);
  }

  extractA2UIData(parts) {
    try {
      // Extract surfaceUpdate
      const surfaceUpdatePart = parts.find(part =>
        part.kind === 'data' &&
        part.data?.surfaceUpdate
      );

      // Extract dataModelUpdate
      const dataModelUpdatePart = parts.find(part =>
        part.kind === 'data' &&
        part.data?.dataModelUpdate
      );

      // Extract beginRendering
      const beginRenderingPart = parts.find(part =>
        part.kind === 'data' &&
        part.data?.beginRendering
      );

      // Construct the result object
      const result = [];

      if (surfaceUpdatePart) {
        result.push({
          surfaceUpdate: surfaceUpdatePart.data.surfaceUpdate
        });
      }

      if (dataModelUpdatePart) {
        const contents = dataModelUpdatePart.data.dataModelUpdate.contents;
        const transformedContents = contents.map(item => ({
          key: item.key,
          valueString: item.valueString
        }));

        result.push({
          dataModelUpdate: {
            surfaceId: dataModelUpdatePart.data.dataModelUpdate.surfaceId,
            contents: transformedContents
          }
        });
      }

      if (beginRenderingPart) {
        result.push({
          beginRendering: beginRenderingPart.data.beginRendering
        });
      }

      return result;
    } catch (error) {
      logger.error(`Error extracting A2A a2ui data information: ${error.message}`);
      return null;
    }
  }
}

// 导出函数（支持 CommonJS 和 ES6 模块）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = A2UIToHTMLConverter;
}

// 全局函数（浏览器环境）
if (typeof window !== 'undefined') {
  window.A2UIToHTMLConverter = A2UIToHTMLConverter;
}

export { A2UIToHTMLConverter };