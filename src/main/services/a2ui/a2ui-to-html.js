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

/**
 * A2UI 到 HTML 转换器
 * 将 Google A2UI 标准格式的文本/JSON 转换为 HTML
 * 使用 @a2ui/lit 官方库进行主题和样式处理
 */

import { v0_8 } from '@a2ui/lit';

// ============================================================================
// 紧凑主题配置 - 针对桌面端对话框优化
// 格式遵循 @a2ui/lit v0_8.Types.Theme 规范
// ============================================================================

/** 基础元素样式 */
const a = {
  'typography-f-sf': true,
  'typography-fs-n': true,
  'typography-w-500': true,
  'layout-as-n': true,
  'layout-dis-iflx': true,
  'layout-al-c': true,
  'typography-td-none': true,
  'color-c-p40': true,
};

const body = {
  'typography-f-s': true,
  'typography-fs-n': true,
  'typography-w-400': true,
  'layout-mt-0': true,
  'layout-mb-2': true,
  'typography-sz-bm': true,
  'color-c-n10': true,
};

const button = {
  'typography-f-sf': true,
  'typography-fs-n': true,
  'typography-w-500': true,
  'layout-pt-2': true,
  'layout-pb-2': true,
  'layout-pl-3': true,
  'layout-pr-3': true,
  'layout-mb-1': true,
  'border-br-12': true,
  'border-bw-0': true,
  'border-c-n70': true,
  'border-bs-s': true,
  'color-bgc-s30': true,
  'behavior-ho-80': true,
};

const heading = {
  'typography-f-sf': true,
  'typography-fs-n': true,
  'typography-w-500': true,
  'layout-mt-0': true,
  'layout-mb-2': true,
};

const input = {
  'typography-f-sf': true,
  'typography-fs-n': true,
  'typography-w-400': true,
  'layout-pl-3': true,
  'layout-pr-3': true,
  'layout-pt-2': true,
  'layout-pb-2': true,
  'border-br-4': true,
  'border-bw-1': true,
  'color-bc-s70': true,
  'border-bs-s': true,
  'layout-as-n': true,
  'color-c-n10': true,
};

const p = {
  'typography-f-s': true,
  'typography-fs-n': true,
  'typography-w-400': true,
  'layout-m-0': true,
  'typography-sz-bm': true,
  'layout-as-n': true,
  'color-c-n10': true,
};

const orderedList = {
  'typography-f-s': true,
  'typography-fs-n': true,
  'typography-w-400': true,
  'layout-m-0': true,
  'typography-sz-bm': true,
  'layout-as-n': true,
  'color-c-n10': true,
};

const unorderedList = { ...orderedList };
const listItem = { ...orderedList };

const pre = {
  'typography-f-c': true,
  'typography-fs-n': true,
  'typography-w-400': true,
  'typography-sz-bm': true,
  'typography-ws-p': true,
  'layout-as-n': true,
};

const textarea = {
  ...input,
  'layout-r-none': true,
  'layout-fs-c': true,
};

// 使用 @a2ui/lit 合并样式
const aLight = v0_8.Styles.merge(a, {});
const inputLight = v0_8.Styles.merge(input, {});
const textareaLight = v0_8.Styles.merge(textarea, {});
const buttonLight = v0_8.Styles.merge(button, {});
const bodyLight = v0_8.Styles.merge(body, {});
const pLight = v0_8.Styles.merge(p, {});
const preLight = v0_8.Styles.merge(pre, {});
const orderedListLight = v0_8.Styles.merge(orderedList, {});
const unorderedListLight = v0_8.Styles.merge(unorderedList, {});
const listItemLight = v0_8.Styles.merge(listItem, {});

/**
 * 紧凑主题配置
 * @type {v0_8.Types.Theme}
 */
const theme = {
  additionalStyles: {
    // 根容器 - 超紧凑布局 + 统一背景
    Root: {
      'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      'font-size': '11px',
      'line-height': '1.35',
      'color': '#1e293b',
      '-webkit-font-smoothing': 'antialiased',
      'word-wrap': 'break-word',
      'overflow-wrap': 'break-word',
      'word-break': 'break-word',
      'background': 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, #e2e8f0 100%)',
      'border-radius': '8px',
      'padding': '10px 12px',
    },
    Button: {
      '--n-35': 'var(--n-100)',
      '--n-10': 'var(--n-0)',
      'background': 'linear-gradient(135deg, #818cf8 0%, #a78bfa 100%)',
      'box-shadow': '0 1px 3px rgba(102, 126, 234, 0.2)',
      'padding': '3px 10px',
      'border-radius': '5px',
      'font-size': '10px',
      'font-weight': '500',
      'cursor': 'pointer',
      'transition': 'all 0.1s ease',
      'color': '#ffffff',
      'border': 'none',
      'white-space': 'nowrap',
    },
    Text: {
      h1: {
        'color': 'transparent',
        'background': 'linear-gradient(135deg, #818cf8 0%, #a78bfa 100%)',
        '-webkit-background-clip': 'text',
        'background-clip': 'text',
        '-webkit-text-fill-color': 'transparent',
        'font-size': '13px',
        'font-weight': '600',
        'margin-bottom': '2px',
        'line-height': '1.25',
      },
      h2: {
        'color': 'transparent',
        'background': 'linear-gradient(135deg, #818cf8 0%, #a78bfa 100%)',
        '-webkit-background-clip': 'text',
        'background-clip': 'text',
        '-webkit-text-fill-color': 'transparent',
        'font-size': '12px',
        'font-weight': '600',
        'margin-bottom': '2px',
        'line-height': '1.25',
      },
      h3: {
        'color': 'transparent',
        'background': 'linear-gradient(135deg, #818cf8 0%, #a78bfa 100%)',
        '-webkit-background-clip': 'text',
        'background-clip': 'text',
        '-webkit-text-fill-color': 'transparent',
        'font-size': '11px',
        'font-weight': '500',
        'margin-bottom': '1px',
        'line-height': '1.25',
      },
      h4: {
        'color': '#1e293b',
        'font-size': '11px',
        'font-weight': '500',
        'margin-bottom': '1px',
        'line-height': '1.25',
      },
      h5: {
        'color': '#1e293b',
        'font-size': '10px',
        'font-weight': '500',
        'margin-bottom': '1px',
        'line-height': '1.25',
      },
      body: {
        'color': '#475569',
        'font-size': '11px',
        'line-height': '1.4',
        'word-wrap': 'break-word',
        'word-break': 'break-word',
      },
      caption: {
        'color': '#64748b',
        'font-size': '10px',
        'line-height': '1.3',
      },
    },
    Card: {
      'background': 'linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
      'border': '1px solid rgba(0,0,0,0.05)',
      'border-radius': '8px',
      'padding': '8px 10px',
      'box-shadow': '0 1px 4px rgba(0,0,0,0.03)',
    },
    // 分隔符样式 - 紧凑间距
    Divider: {
      horizontal: {
        'height': '1px',
        'width': '100%',
        'background': 'linear-gradient(90deg, transparent 0%, rgba(148,163,184,0.25) 15%, rgba(148,163,184,0.25) 85%, transparent 100%)',
        'border': 'none',
        'margin': '6px 0',
      },
      vertical: {
        'width': '1px',
        'align-self': 'stretch',
        'background': 'linear-gradient(180deg, transparent 0%, rgba(148,163,184,0.25) 15%, rgba(148,163,184,0.25) 85%, transparent 100%)',
        'border': 'none',
        'margin': '0 6px',
        'flex-shrink': '0',
      },
    },
    TextField: {
      '--p-0': 'var(--n-0)',
      'background': '#ffffff',
      'border': '1px solid rgba(0,0,0,0.08)',
      'border-radius': '4px',
      'padding': '4px 8px',
      'font-size': '11px',
      'transition': 'border-color 0.12s ease, box-shadow 0.12s ease',
    },
    // 列表 - 紧凑间距
    List: {
      'background': 'transparent',
    },
    // 模态框 - 适应紧凑布局
    Modal: {
      backdrop: {
        'background': 'rgba(15, 23, 42, 0.35)',
        'backdrop-filter': 'blur(3px)',
      },
      element: {
        'background': '#ffffff',
        'border-radius': '10px',
        'box-shadow': '0 12px 28px rgba(0,0,0,0.12), 0 4px 10px rgba(0,0,0,0.08)',
        'padding': '12px',
      },
    },
    // 图片样式 - 紧凑尺寸
    Image: {
      'border-radius': '4px',
      'object-fit': 'cover',
      'max-width': '100%',
      'max-height': '120px',
    },
    // 行布局 - 横向扩展，紧凑间距
    Row: {
      'display': 'flex',
      'flex-direction': 'row',
      'gap': '6px',
      'align-items': 'center',
      'flex-wrap': 'wrap',
      'width': '100%',
    },
    // 列布局 - 紧凑纵向间距
    Column: {
      'display': 'flex',
      'flex-direction': 'column',
      'gap': '4px',
      'width': '100%',
    },
    // 复选框
    CheckBox: {
      'cursor': 'pointer',
      'font-size': '11px',
    },
    // 图标 - 小尺寸
    Icon: {
      'color': '#64748b',
      'display': 'inline-flex',
      'align-items': 'center',
      'justify-content': 'center',
      'font-size': '12px',
    },
  },
  components: {
    AudioPlayer: {},
    // 按钮 - 紧凑内边距
    Button: {
      'layout-pt-1': true,
      'layout-pb-1': true,
      'layout-pl-2': true,
      'layout-pr-2': true,
      'border-br-6': true,
      'border-bw-0': true,
      'border-bs-s': true,
      'color-bgc-p30': true,
      'behavior-ho-70': true,
      'typography-w-500': true,
      'typography-f-sf': true,
      'typography-sz-sm': true,
      'layout-dsp-iflex': true,
      'layout-al-c': true,
    },
    // 卡片 - 紧凑内边距
    Card: {
      'border-br-6': true,
      'layout-p-2': true,
      'color-bgc-n100': true,
      'border-bw-1': true,
      'border-bs-s': true,
    },
    // 复选框 - 紧凑间距
    CheckBox: {
      element: {
        'layout-m-0': true,
        'layout-mr-1': true,
        'border-br-2': true,
        'border-bw-1': true,
        'border-bs-s': true,
        'color-bgc-n100': true,
        'color-bc-n70': true,
      },
      label: {
        'color-c-n30': true,
        'typography-f-sf': true,
        'typography-w-400': true,
        'layout-flx-1': true,
        'typography-sz-sm': true,
      },
      container: {
        'layout-dsp-iflex': true,
        'layout-al-c': true,
        'layout-g-1': true,
      },
    },
    // 列布局 - 紧凑纵向间距
    Column: {
      'layout-g-1': true,
      'layout-dsp-flexver': true,
      'layout-w-100': true,
    },
    // 日期时间输入 - 紧凑尺寸
    DateTimeInput: {
      container: {
        'typography-sz-sm': true,
        'layout-w-100': true,
        'layout-g-1': true,
        'layout-dsp-flexhor': true,
        'layout-al-c': true,
        'typography-ws-nw': true,
      },
      label: {
        'color-c-n50': true,
        'typography-sz-xs': true,
        'typography-w-500': true,
      },
      element: {
        'layout-pt-1': true,
        'layout-pb-1': true,
        'layout-pl-2': true,
        'layout-pr-2': true,
        'border-br-3': true,
        'border-bw-1': true,
        'border-bs-s': true,
        'color-bgc-n100': true,
        'color-bc-n70': true,
        'color-c-n10': true,
        'typography-sz-sm': true,
      },
    },
    // 分隔符 - 紧凑间距
    Divider: {
      horizontal: {
        'layout-w-100': true,
        'layout-mt-1': true,
        'layout-mb-1': true,
      },
      vertical: {
        'layout-as-st': true,
        'layout-ml-1': true,
        'layout-mr-1': true,
      },
    },
    // 图片 - 紧凑尺寸
    Image: {
      all: {
        'border-br-3': true,
        'layout-el-cv': true,
      },
      avatar: {
        'is-avatar': true,
        'border-br-full': true,
      },
      header: {
        'layout-w-100': true,
        'border-br-4': true,
      },
      icon: {
        'border-br-0': true,
      },
      largeFeature: {
        'layout-w-100': true,
      },
      mediumFeature: {},
      smallFeature: {},
    },
    // 图标 - 紧凑尺寸
    Icon: {
      'layout-dsp-iflex': true,
      'layout-al-c': true,
      'layout-jc-c': true,
      'color-c-n50': true,
      'typography-sz-sm': true,
    },
    // 列表 - 紧凑间距
    List: {
      'layout-g-1': true,
      'layout-dsp-flexver': true,
    },
    // 模态框 - 紧凑内边距
    Modal: {
      backdrop: {
        'color-bbgc-n10_35': true,
      },
      element: {
        'border-br-8': true,
        'color-bgc-n100': true,
        'layout-p-3': true,
      },
    },
    // 多选 - 紧凑间距
    MultipleChoice: {
      container: {
        'layout-g-1': true,
      },
      label: {
        'typography-sz-xs': true,
        'color-c-n50': true,
      },
      element: {},
    },
    // 行布局 - 紧凑间距，横向扩展
    Row: {
      'layout-g-1': true,
      'layout-dsp-flexhor': true,
      'layout-al-c': true,
      'layout-w-100': true,
      'layout-fw-w': true,
    },
    // 滑块 - 紧凑间距
    Slider: {
      container: {
        'layout-g-1': true,
      },
      label: {
        'typography-sz-xs': true,
        'color-c-n50': true,
      },
      element: {},
    },
    // 标签页 - 紧凑内边距
    Tabs: {
      container: {
        'layout-g-1': true,
      },
      controls: {
        all: {
          'layout-pt-1': true,
          'layout-pb-1': true,
          'layout-pl-2': true,
          'layout-pr-2': true,
          'color-c-n50': true,
          'typography-w-500': true,
          'typography-sz-sm': true,
        },
        selected: {
          'color-c-p40': true,
          'border-bb-2': true,
          'color-bc-p40': true,
        },
      },
      element: {},
    },
    // 文本 - 紧凑字号和间距
    Text: {
      all: {
        'layout-w-100': true,
        'typography-f-sf': true,
      },
      h1: {
        'typography-f-sf': true,
        'typography-v-r': true,
        'typography-w-600': true,
        'layout-m-0': true,
        'layout-p-0': true,
        'typography-sz-tl': true,
        'layout-mb-1': true,
      },
      h2: {
        'typography-f-sf': true,
        'typography-v-r': true,
        'typography-w-600': true,
        'layout-m-0': true,
        'layout-p-0': true,
        'typography-sz-ll': true,
        'layout-mb-1': true,
      },
      h3: {
        'typography-f-sf': true,
        'typography-v-r': true,
        'typography-w-500': true,
        'layout-m-0': true,
        'layout-p-0': true,
        'typography-sz-bm': true,
        'layout-mb-1': true,
      },
      h4: {
        'typography-f-sf': true,
        'typography-v-r': true,
        'typography-w-500': true,
        'layout-m-0': true,
        'layout-p-0': true,
        'typography-sz-sm': true,
        'color-c-n10': true,
      },
      h5: {
        'typography-f-sf': true,
        'typography-v-r': true,
        'typography-w-500': true,
        'layout-m-0': true,
        'layout-p-0': true,
        'typography-sz-sm': true,
        'color-c-n10': true,
      },
      body: {
        'color-c-n30': true,
        'typography-sz-sm': true,
        'typography-lh-normal': true,
      },
      caption: {
        'color-c-n50': true,
        'typography-sz-xs': true,
      },
    },
    // 输入框 - 紧凑尺寸
    TextField: {
      container: {
        'typography-sz-sm': true,
        'layout-w-100': true,
        'layout-g-0': true,
        'layout-dsp-flexver': true,
      },
      label: {
        'layout-flx-0': true,
        'color-c-n50': true,
        'typography-sz-xs': true,
        'typography-w-500': true,
        'layout-mb-0': true,
      },
      element: {
        'typography-sz-sm': true,
        'layout-pt-1': true,
        'layout-pb-1': true,
        'layout-pl-2': true,
        'layout-pr-2': true,
        'border-br-3': true,
        'border-bw-1': true,
        'border-bs-s': true,
        'color-bgc-n100': true,
        'color-bc-n70': true,
        'color-c-n10': true,
      },
    },
    // 视频 - 紧凑尺寸
    Video: {
      'border-br-4': true,
      'layout-el-cv': true,
      'layout-w-100': true,
    },
  },
  elements: {
    a: aLight,
    body: bodyLight,
    button: buttonLight,
    h1: heading,
    h2: heading,
    h3: heading,
    h4: heading,
    h5: heading,
    input: inputLight,
    p: pLight,
    pre: preLight,
    textarea: textareaLight,
  },
  markdown: {
    p: [...Object.keys(pLight)],
    h1: [...Object.keys(heading)],
    h2: [...Object.keys(heading)],
    h3: [...Object.keys(heading)],
    h4: [...Object.keys(heading)],
    h5: [...Object.keys(heading)],
    ul: [...Object.keys(unorderedListLight)],
    ol: [...Object.keys(orderedListLight)],
    li: [...Object.keys(listItemLight)],
    a: [...Object.keys(aLight)],
    strong: [],
    em: [],
  },
};

// ============================================================================
// A2UI 转换器类
// ============================================================================

class A2UIToHTMLConverter {
  constructor() {
    this.componentBuffers = {};
    this.dataModels = {};
    this.renderStyles = {};
    this.renderRootId = null;
    this.renderSurfaceId = null;
    this.theme = theme;
  }

  /**
   * 获取 @a2ui/lit 主题配置
   */
  getTheme() {
    return this.theme;
  }

  /**
   * 使用 @a2ui/lit Styles.merge 合并样式
   */
  mergeStyles(...styles) {
    return v0_8.Styles.merge(...styles);
  }

  handleSurfaceUpdate(msg) {
    const { surfaceId, components } = msg.surfaceUpdate;
    if (!this.componentBuffers[surfaceId]) {
      this.componentBuffers[surfaceId] = {};
    }
    components.forEach(comp => {
      this.componentBuffers[surfaceId][comp.id] = comp.component;
    });
  }

  // 辅助函数：递归解析 A2UI 值类型
  _parseA2UIValue(item) {
      if (!item) return null;
      if (item.valueString !== undefined) return item.valueString;
      if (item.valueNumber !== undefined) return item.valueNumber;
      if (item.valueBoolean !== undefined) return item.valueBoolean;
      
      // 处理 valueMap (用于 List 渲染)
      if (item.valueMap !== undefined && Array.isArray(item.valueMap)) {
          const resultObj = {};
          item.valueMap.forEach(subItem => {
              resultObj[subItem.key] = this._parseA2UIValue(subItem);
          });

          return resultObj;
      }
      return null;
  }
  handleDataModelUpdate(msg) {
    const { surfaceId, contents } = msg.dataModelUpdate;
    if (!this.dataModels[surfaceId]) {
      this.dataModels[surfaceId] = {};
    }
    contents.forEach(item => {
      this.dataModels[surfaceId][item.key] = this._parseA2UIValue(item);
    });
  }

  handleBeginRendering(msg) {
    this.renderSurfaceId = msg.beginRendering.surfaceId;
    this.renderRootId = msg.beginRendering.root;
    if (msg.beginRendering.styles && this.renderSurfaceId) {
      this.renderStyles[this.renderSurfaceId] = msg.beginRendering.styles;
    }
  }

  handleDeleteSurface(msg) {
    const { surfaceId } = msg.deleteSurface;
    delete this.componentBuffers[surfaceId];
    delete this.dataModels[surfaceId];
    delete this.renderStyles[surfaceId];
  }

  mergeStyleStrings(...styleParts) {
    const parts = styleParts
      .filter(Boolean)
      .map(s => String(s).trim())
      .filter(Boolean)
      .map(s => (s.endsWith(';') ? s.slice(0, -1) : s));
    return parts.length ? parts.join('; ') : null;
  }

  /**
   * 从 props 中获取内联样式，过滤掉会破坏紧凑布局的属性
   */
  getInlineStyleFromProps(props, filterTypography = true) {
    if (!props) return null;
    let styleStr = null;
    if (typeof props.style === 'string') styleStr = props.style;
    else if (typeof props.styles === 'string') styleStr = props.styles;
    else if (typeof props.css === 'string') styleStr = props.css;
    
    if (!styleStr) return null;
    
    // 过滤掉会破坏紧凑布局的样式属性
    if (filterTypography) {
      const blockedProps = [
        // 字体相关
        'font-size', 'font-weight', 'font-family', 'font-style',
        'line-height', 'letter-spacing', 'word-spacing', 'text-indent',
        // 尺寸相关
        'width', 'height',
        'min-width', 'min-height', 'max-width', 'max-height',
        // 间距相关
        'padding', 'margin',
        'gap', 'row-gap', 'column-gap',
        // 定位相关（可能影响布局）
        'top', 'right', 'bottom', 'left',
        'inset',
        // flex/grid 子项尺寸
        'flex-basis', 'flex-grow', 'flex-shrink',
        // 其他可能影响布局的属性
        'transform', 'scale', 'zoom',
        'position', // 防止 absolute/fixed 定位破坏流式布局
      ];
      const filteredStyles = styleStr
        .split(';')
        .map(s => s.trim())
        .filter(s => {
          if (!s) return false;
          const propName = s.split(':')[0]?.trim().toLowerCase();
          return !blockedProps.some(blocked => propName === blocked || propName.startsWith(blocked + '-'));
        })
        .join('; ');
      return filteredStyles || null;
    }
    
    return styleStr;
  }

  pickTextTag(props) {
    const hint = props?.usageHint || props?.variant;
    if (!hint) return 'span';
    const h = String(hint).toLowerCase();
    if (h.startsWith('h1') || h === 'headline' || h === 'title') return 'h1';
    if (h.startsWith('h2') || h === 'subtitle') return 'h2';
    if (h.startsWith('h3')) return 'h3';
    if (h.startsWith('h4')) return 'h4';
    if (h.startsWith('h5')) return 'h5';
    if (h === 'body' || h === 'paragraph') return 'p';
    return 'span';
  }

  resolveBoundValue(boundVal, dataModel) {
    if (!boundVal || typeof boundVal !== 'object') return boundVal;
    if (boundVal.literalString !== undefined) return String(boundVal.literalString);
    if (boundVal.literalInt !== undefined) return boundVal.literalInt;
    if (boundVal.literalDouble !== undefined) return boundVal.literalDouble;
    if (boundVal.literalBool !== undefined) return boundVal.literalBool;
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

  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * 获取组件的样式类名列表
   */
  getComponentStyleClasses(componentType, variant = null) {
    const compConfig = this.theme.components?.[componentType];
    if (!compConfig) return [];
    
    if (variant && compConfig[variant]) {
      return Object.keys(compConfig[variant]).filter(k => compConfig[variant][k]);
    }
    return Object.keys(compConfig).filter(k => compConfig[k] === true);
  }

  /**
   * 获取额外的组件内联样式
   */
  getAdditionalStyles(componentType, variant = null) {
    const addStyles = this.theme.additionalStyles?.[componentType];
    if (!addStyles) return '';
    
    if (variant && addStyles[variant]) {
      return Object.entries(addStyles[variant])
        .map(([prop, val]) => `${prop}: ${val}`)
        .join('; ');
    }
    
    // 过滤掉嵌套对象（如 h1, h2 等）
    const directStyles = Object.entries(addStyles)
      .filter(([, val]) => typeof val !== 'object')
      .map(([prop, val]) => `${prop}: ${val}`)
      .join('; ');
    
    return directStyles;
  }

  renderComponentById(id, compBuf, dataModel) {
    const compObj = compBuf[id];
    if (!compObj) return '';
    const keys = Object.keys(compObj);
    if (keys.length !== 1) return '';
    const type = keys[0];
    const props = compObj[type];

    switch (type) {
      case 'Text': {
        const textVal = this.resolveBoundValue(props.text, dataModel);
        const escapedText = this.escapeHtml(textVal);
        const tag = this.pickTextTag(props);
        const variant = this.getTextVariant(props);
        const styleClasses = this.getComponentStyleClasses('Text', variant);
        const additionalStyle = this.getAdditionalStyles('Text', variant);
        const inlineStyle = this.mergeStyleStrings(additionalStyle, this.getInlineStyleFromProps(props));
        return `<${tag} class="${styleClasses.join(' ')}"${inlineStyle ? ` style="${inlineStyle}"` : ''}>${escapedText}</${tag}>`;
      }
      case 'Image': {
        const url = this.resolveBoundValue(props.url || props.src, dataModel);
        const alt = this.resolveBoundValue(props.alt, dataModel) || '';
        const usageHint = props.usageHint || 'all';
        const styleClasses = this.getComponentStyleClasses('Image', usageHint);
        const additionalStyle = this.getAdditionalStyles('Image');
        const buildStyle = this.buildImageStyle(props);
        const style = this.mergeStyleStrings(additionalStyle, buildStyle, this.getInlineStyleFromProps(props));
        return `<img class="a2ui-image a2ui-image--${usageHint} ${styleClasses.join(' ')}" src="${this.escapeHtml(url)}" alt="${this.escapeHtml(alt)}"${style ? ` style="${style}"` : ''} />`;
      }
      case 'Button': {
        const childId = props.child;
        let childHtml = childId ? this.renderComponentById(childId, compBuf, dataModel) : '';
        const styleClasses = this.getComponentStyleClasses('Button');
        const additionalStyle = this.getAdditionalStyles('Button');
        const style = this.mergeStyleStrings(additionalStyle, this.getInlineStyleFromProps(props));
        const disabled = props.disabled ? ' disabled' : '';
        
        // 将 action 数据序列化到 data-action 属性中
        let actionAttr = '';
        if (props.action) {
            // 安全地序列化 JSON，防止引号冲突
            const actionJson = JSON.stringify(props.action).replace(/"/g, '&quot;');
            actionAttr = ` data-a2ui-action="${actionJson}"`;
            if (props.action.name === 'close_result') {
                childHtml = 'Done';
            }
        }
        
        
        // 添加 class "a2ui-interactive-btn" 以便 entry.js 监听
        return `<button class="a2ui-interactive-btn ${styleClasses.join(' ')}"${style ? ` style="${style}"` : ''}${disabled}${actionAttr}>${childHtml}</button>`;
      }

      case 'MultipleChoice': {
        // MultipleChoice 渲染逻辑，确保 input 有正确的 name 和 value
        const containerClasses = this.getComponentStyleClasses('MultipleChoice', 'container');
        const labelClasses = this.getComponentStyleClasses('MultipleChoice', 'label');
        const additionalStyle = this.getAdditionalStyles('MultipleChoice');
        
        const options = props.options || [];
        const groupName = `group_${id}_${Math.random().toString(36).substr(2, 5)}`;
        
        const optionsHtml = options.map((opt, index) => {
            const label = this.resolveBoundValue(opt.label, dataModel) || '';
            const val = opt.value || '';
            return `
                <label class="a2ui-radio-option" style="display:flex; align-items:center; margin-bottom:4px; cursor:pointer;">
                    <input type="radio" 
                           name="${groupName}" 
                           value="${val}" 
                           data-component-id="${id}"
                           class="a2ui-radio-input" 
                           style="margin-right:6px;">
                    <span class="${labelClasses.join(' ')}">${this.escapeHtml(label)}</span>
                </label>
            `;
        }).join('');

        return `<div class="a2ui-multiplechoice ${containerClasses.join(' ')}"${additionalStyle ? ` style="${additionalStyle}"` : ''} id="${id}">
            ${optionsHtml}
        </div>`;
      }
      case 'Column': {
        const children = this.getChildren(props, compBuf, dataModel);
        const styleClasses = this.getComponentStyleClasses('Column');
        const additionalStyle = this.getAdditionalStyles('Column');
        const layoutStyle = this.buildLayoutStyle(props, 'column');
        const style = this.mergeStyleStrings(additionalStyle, layoutStyle, this.getInlineStyleFromProps(props));
        return `<div class="a2ui-column ${styleClasses.join(' ')}"${style ? ` style="${style}"` : ''}>${children}</div>`;
      }
      case 'Row': {
        const children = this.getChildren(props, compBuf, dataModel);
        const styleClasses = this.getComponentStyleClasses('Row');
        const additionalStyle = this.getAdditionalStyles('Row');
        const layoutStyle = this.buildLayoutStyle(props, 'row');
        const style = this.mergeStyleStrings(additionalStyle, layoutStyle, this.getInlineStyleFromProps(props));
        return `<div class="a2ui-row ${styleClasses.join(' ')}"${style ? ` style="${style}"` : ''}>${children}</div>`;
      }
      case 'Divider': {
        const axis = (props.axis || 'horizontal').toLowerCase();
        const styleClasses = this.getComponentStyleClasses('Divider', axis);
        const additionalStyle = this.getAdditionalStyles('Divider', axis);
        const inlineStyle = this.mergeStyleStrings(additionalStyle, this.getInlineStyleFromProps(props));
        return `<hr class="a2ui-divider a2ui-divider--${axis} ${styleClasses.join(' ')}" role="separator" aria-orientation="${axis}"${inlineStyle ? ` style="${inlineStyle}"` : ''} />`;
      }
      case 'TextField': {
        const placeholder = this.resolveBoundValue(props.placeholder, dataModel) || '';
        const value = this.resolveBoundValue(props.value, dataModel) || '';
        const label = this.resolveBoundValue(props.label, dataModel) || '';
        const containerClasses = this.getComponentStyleClasses('TextField', 'container');
        const labelClasses = this.getComponentStyleClasses('TextField', 'label');
        const elementClasses = this.getComponentStyleClasses('TextField', 'element');
        const additionalStyle = this.getAdditionalStyles('TextField');
        const inputHtml = `<input class="a2ui-textfield__input ${elementClasses.join(' ')}" type="text" placeholder="${this.escapeHtml(placeholder)}" value="${this.escapeHtml(value)}"${additionalStyle ? ` style="${additionalStyle}"` : ''} />`;
        if (label) {
          return `<div class="a2ui-textfield ${containerClasses.join(' ')}"><label class="a2ui-textfield__label ${labelClasses.join(' ')}">${this.escapeHtml(label)}</label>${inputHtml}</div>`;
        }
        return `<div class="a2ui-textfield ${containerClasses.join(' ')}">${inputHtml}</div>`;
      }
      case 'CheckBox': {
        const label = this.resolveBoundValue(props.label, dataModel) || '';
        const checked = props.checked ? ' checked' : '';
        const containerClasses = this.getComponentStyleClasses('CheckBox', 'container');
        const elementClasses = this.getComponentStyleClasses('CheckBox', 'element');
        const labelClasses = this.getComponentStyleClasses('CheckBox', 'label');
        const additionalStyle = this.getAdditionalStyles('CheckBox');
        return `<label class="a2ui-checkbox ${containerClasses.join(' ')}"${additionalStyle ? ` style="${additionalStyle}"` : ''}><input class="a2ui-checkbox__input ${elementClasses.join(' ')}" type="checkbox"${checked} /><span class="a2ui-checkbox__label ${labelClasses.join(' ')}">${this.escapeHtml(label)}</span></label>`;
      }
      case 'Card': {
        const children = this.getChildren(props, compBuf, dataModel);
        const styleClasses = this.getComponentStyleClasses('Card');
        const additionalStyle = this.getAdditionalStyles('Card');
        const style = this.mergeStyleStrings(additionalStyle, this.getInlineStyleFromProps(props));
        return `<div class="${styleClasses.join(' ')}"${style ? ` style="${style}"` : ''}>${children}</div>`;
      }
      case 'Container':
      case 'Box': {
        const children = this.getChildren(props, compBuf, dataModel);
        const style = this.buildContainerStyle(props);
        return `<div${style ? ` style="${style}"` : ''}>${children}</div>`;
      }
      case 'List': {
        const children = this.getChildren(props, compBuf, dataModel);
        const styleClasses = this.getComponentStyleClasses('List');
        const additionalStyle = this.getAdditionalStyles('List');
        return `<div class="a2ui-list ${styleClasses.join(' ')}"${additionalStyle ? ` style="${additionalStyle}"` : ''}>${children}</div>`;
      }
      case 'Modal': {
        const children = this.getChildren(props, compBuf, dataModel);
        const backdropClasses = this.getComponentStyleClasses('Modal', 'backdrop');
        const elementClasses = this.getComponentStyleClasses('Modal', 'element');
        const backdropStyle = this.getAdditionalStyles('Modal', 'backdrop');
        const elementStyle = this.getAdditionalStyles('Modal', 'element');
        return `<div class="a2ui-modal"><div class="a2ui-modal__backdrop ${backdropClasses.join(' ')}"${backdropStyle ? ` style="${backdropStyle}"` : ''}></div><div class="a2ui-modal__content ${elementClasses.join(' ')}"${elementStyle ? ` style="${elementStyle}"` : ''}>${children}</div></div>`;
      }
      case 'Tabs': {
        const children = this.getChildren(props, compBuf, dataModel);
        const styleClasses = this.getComponentStyleClasses('Tabs', 'container');
        return `<div class="${styleClasses.join(' ')}">${children}</div>`;
      }
      case 'Icon': {
        const iconName = this.resolveBoundValue(props.icon || props.name, dataModel) || '';
        const styleClasses = this.getComponentStyleClasses('Icon');
        const additionalStyle = this.getAdditionalStyles('Icon');
        return `<span class="a2ui-icon ${styleClasses.join(' ')}"${additionalStyle ? ` style="${additionalStyle}"` : ''}>${this.escapeHtml(iconName)}</span>`;
      }
      case 'Video': {
        const url = this.resolveBoundValue(props.url || props.src, dataModel);
        const styleClasses = this.getComponentStyleClasses('Video');
        return `<video class="${styleClasses.join(' ')}" src="${this.escapeHtml(url)}" controls></video>`;
      }
      default: {
        const defaultChildren = this.getChildren(props, compBuf, dataModel);
        return `<div class="a2ui-${type.toLowerCase()}">${defaultChildren}</div>`;
      }
    }
  }

  getTextVariant(props) {
    const hint = props?.usageHint || props?.variant || 'body';
    const h = String(hint).toLowerCase();
    if (h.startsWith('h1') || h === 'headline' || h === 'title') return 'h1';
    if (h.startsWith('h2') || h === 'subtitle') return 'h2';
    if (h.startsWith('h3')) return 'h3';
    if (h.startsWith('h4')) return 'h4';
    if (h.startsWith('h5')) return 'h5';
    if (h === 'caption' || h === 'small') return 'caption';
    return 'body';
  }

  // 
  getChildren(props, compBuf, dataModel) {
    if (props.children) {
      if (props.children.explicitList) {
        return props.children.explicitList.map(childId => this.renderComponentById(childId, compBuf, dataModel)).join('');
      } else if (props.children.template) {
        const template = props.children.template;
        // 优先使用 dataBinding (标准属性)，兼容 listPath
        const listPath = template.dataBinding || template.listPath;
        
        if (listPath && dataModel) {
          const rawData = this.resolveBoundValue({ path: listPath }, dataModel);
          let list = [];

          // 处理数据源：如果是数组直接用，如果是对象(Map)则取其 values
          if (Array.isArray(rawData)) {
              list = rawData;
          } else if (rawData && typeof rawData === 'object') {
              list = Object.values(rawData);
          }

          if (list.length > 0) {
            return list.map((item) => {
                // 创建一个合并了当前 item 数据的临时 Model
                const itemDataModel = { ...dataModel, ...item };
                return this.renderComponentById(template.componentId, compBuf, itemDataModel);
            }).join('');
          }
        }
      }
    }
    if (props.child) return this.renderComponentById(props.child, compBuf, dataModel);
    return '';
  }

  buildImageStyle(props) {
    const styles = [];
    // 限制图片最大尺寸以保持紧凑布局
    if (props.width) {
      const w = typeof props.width === 'number' ? props.width : parseInt(props.width) || 100;
      styles.push(`width: ${Math.min(w, 200)}px`);
    }
    if (props.height) {
      const h = typeof props.height === 'number' ? props.height : parseInt(props.height) || 100;
      styles.push(`height: ${Math.min(h, 100)}px`);
    }
    if (props.borderRadius) {
      const br = Math.min(parseInt(props.borderRadius) || 4, 12);
      styles.push(`border-radius: ${br}px`);
    }
    // 强制限制最大高度
    styles.push(`max-height: 100px`);
    return this.mergeStyleStrings(styles.join('; '), this.getInlineStyleFromProps(props, true));
  }

  buildLayoutStyle(props, direction) {
    const styles = [`display: flex`, `flex-direction: ${direction}`, `width: 100%`];
    // 限制 gap 最大值以保持紧凑
    if (props.gap) {
      const gapVal = Math.min(parseInt(props.gap) || 4, 8);
      styles.push(`gap: ${gapVal}px`);
    }
    // 限制 padding 最大值
    if (props.padding) {
      const padVal = Math.min(parseInt(props.padding) || 0, 12);
      styles.push(`padding: ${padVal}px`);
    }
    if (props.alignment) styles.push(`align-items: ${this.mapFlexAlign(props.alignment)}`);
    if (props.justification) styles.push(`justify-content: ${this.mapFlexAlign(props.justification)}`);
    // 过滤掉原始样式中会破坏布局的属性
    return this.mergeStyleStrings(styles.join('; '), this.getInlineStyleFromProps(props, true)) || '';
  }

  buildContainerStyle(props) {
    const styles = [];
    if (props.backgroundColor) styles.push(`background-color: ${props.backgroundColor}`);
    // 限制 padding/margin 最大值
    if (props.padding) {
      const padVal = Math.min(parseInt(props.padding) || 0, 12);
      styles.push(`padding: ${padVal}px`);
    }
    if (props.margin) {
      const marginVal = Math.min(parseInt(props.margin) || 0, 8);
      styles.push(`margin: ${marginVal}px`);
    }
    // 不使用原始的 width/height，让布局自适应
    return this.mergeStyleStrings(styles.join('; '), this.getInlineStyleFromProps(props, true));
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
   * 生成基础 CSS 样式 - 超紧凑布局
   */
  generateBaseStyles() {
    const rootStyles = this.getAdditionalStyles('Root');
    return `
/* A2UI 超紧凑布局基础样式 */
.a2ui-root {
  ${rootStyles || 'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 11px; line-height: 1.35; color: #1e293b;'}
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  word-wrap: break-word;
  overflow-wrap: break-word;
  word-break: break-word;
  max-width: 100%;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, #e2e8f0 100%);
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03);
}

/* 通用样式 */
.a2ui-root * {
  box-sizing: border-box;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

/* 加粗文本 - 与正文大小一致 */
.a2ui-root strong, .a2ui-root b {
  font-weight: 600;
  font-size: inherit;
  color: #334155;
}

/* 分隔符样式 - 超紧凑间距 */
.a2ui-divider {
  border: none;
  margin: 0;
  flex-shrink: 0;
}
.a2ui-divider--horizontal {
  height: 1px;
  width: 100%;
  background: linear-gradient(90deg, transparent 0%, rgba(148,163,184,0.2) 10%, rgba(148,163,184,0.2) 90%, transparent 100%);
  margin: 4px 0;
}
.a2ui-divider--vertical {
  width: 1px;
  align-self: stretch;
  min-height: 10px;
  background: linear-gradient(180deg, transparent 0%, rgba(148,163,184,0.2) 10%, rgba(148,163,184,0.2) 90%, transparent 100%);
  margin: 0 4px;
  flex-shrink: 0;
}

/* 布局组件 - 超紧凑间距，横向扩展优先 */
.a2ui-row {
  display: flex;
  flex-direction: row;
  gap: 4px;
  align-items: flex-start;
  flex-wrap: wrap;
  width: 100%;
}
.a2ui-column {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
}
.a2ui-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 模态框 - 紧凑尺寸 */
.a2ui-modal {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.a2ui-modal__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(15, 23, 42, 0.3);
  backdrop-filter: blur(2px);
}
.a2ui-modal__content {
  position: relative;
  background: #ffffff;
  border-radius: 8px;
  box-shadow: 0 8px 20px rgba(0,0,0,0.1), 0 3px 8px rgba(0,0,0,0.06);
  padding: 10px;
  max-width: 95vw;
  max-height: 65vh;
  overflow: auto;
}

/* 按钮 - 超紧凑尺寸 */
.a2ui-root button {
  font-size: 10px;
  padding: 3px 10px;
  border-radius: 5px;
  white-space: nowrap;
  line-height: 1.3;
}
.a2ui-root button:hover {
  opacity: 0.9;
}
.a2ui-root button:active {
  opacity: 0.8;
}

/* 图片 - 限制高度 */
.a2ui-image {
  max-width: 100%;
  max-height: 100px;
  height: auto;
  border-radius: 3px;
  object-fit: cover;
}
.a2ui-image--avatar {
  border-radius: 50%;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}
.a2ui-image--icon {
  border-radius: 0;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}
.a2ui-image--header {
  max-height: 60px;
  width: 100%;
  object-fit: cover;
}

/* 输入框 - 超紧凑尺寸 */
.a2ui-textfield {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
}
.a2ui-textfield__label {
  font-size: 9px;
  font-weight: 500;
  color: #64748b;
}
.a2ui-textfield__input {
  padding: 3px 6px;
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 3px;
  font-size: 10px;
  background: #ffffff;
  transition: border-color 0.1s ease;
  width: 100%;
  line-height: 1.3;
}
.a2ui-textfield__input:focus {
  outline: none;
  border-color: #818cf8;
  box-shadow: 0 0 0 1px rgba(129, 140, 248, 0.1);
}

/* 复选框 - 超紧凑尺寸 */
.a2ui-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
}
.a2ui-checkbox__input {
  margin: 0;
  cursor: pointer;
  width: 11px;
  height: 11px;
}
.a2ui-checkbox__label {
  font-size: 10px;
  color: #475569;
}

/* 图标 - 小尺寸 */
.a2ui-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  font-size: 11px;
}

/* 卡片 - 紧凑内边距 */
.a2ui-card {
  padding: 6px 8px;
  border-radius: 6px;
}

/* 标题 - 超紧凑行高和间距 */
.a2ui-root h1, .a2ui-root h2, .a2ui-root h3, .a2ui-root h4, .a2ui-root h5 {
  margin: 0;
  line-height: 1.25;
  word-wrap: break-word;
}
.a2ui-root h1 { font-size: 13px; margin-bottom: 2px; font-weight: 600; }
.a2ui-root h2 { font-size: 12px; margin-bottom: 2px; font-weight: 600; }
.a2ui-root h3 { font-size: 11px; margin-bottom: 1px; font-weight: 500; }
.a2ui-root h4 { font-size: 11px; margin-bottom: 1px; font-weight: 500; }
.a2ui-root h5 { font-size: 10px; margin-bottom: 1px; font-weight: 500; }

/* 段落和正文 - 超紧凑间距 */
.a2ui-root p {
  margin: 0 0 2px 0;
  font-size: 11px;
  line-height: 1.4;
  word-wrap: break-word;
  word-break: break-word;
}
.a2ui-root span {
  font-size: 11px;
  line-height: 1.4;
  word-wrap: break-word;
}

/* 链接 */
.a2ui-root a {
  color: #6366f1;
  text-decoration: none;
  font-size: inherit;
}
.a2ui-root a:hover {
  text-decoration: underline;
}
`;
  }

  processMessages(messages, options = {}) {
    const { fullDocument = false, includeStyles = true } = options;
    this.componentBuffers = {};
    this.dataModels = {};
    this.renderRootId = null;
    this.renderSurfaceId = null;

    messages.forEach(msg => {
      if (msg.surfaceUpdate) this.handleSurfaceUpdate(msg);
      else if (msg.dataModelUpdate) this.handleDataModelUpdate(msg);
      else if (msg.beginRendering) this.handleBeginRendering(msg);
      else if (msg.deleteSurface) this.handleDeleteSurface(msg);
    });

    if (!this.renderRootId || !this.renderSurfaceId) return '';
    const compBuf = this.componentBuffers[this.renderSurfaceId];
    const dataModel = this.dataModels[this.renderSurfaceId] || {};
    if (!compBuf) return '';

    const rootHtml = this.renderComponentById(this.renderRootId, compBuf, dataModel);
    const rootAdditionalStyle = this.getAdditionalStyles('Root');
    let rawDataSafe = '';
    try {
        if (messages) {
            rawDataSafe = encodeURIComponent(JSON.stringify(messages));
        }
    } catch (e) {
        console.error("序列化 A2UI 数据失败:", e);
    }
    const contentHtml = `<div class="a2ui-root" data-a2ui-model="${rawDataSafe}"${rootAdditionalStyle ? ` style="${rootAdditionalStyle}"` : ''}>${rootHtml}</div>`;
    const styleBlock = includeStyles ? `<style>${this.generateBaseStyles()}</style>` : '';

    if (fullDocument) {
      return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>A2UI</title>
  ${styleBlock}
</head>
<body style="margin: 0; padding: 0;">
  ${contentHtml}
</body>
</html>`;
    }
    return styleBlock + contentHtml;
  }

  convertFromJSONL(jsonlText, options = {}) {
    const lines = jsonlText.trim().split('\n').filter(line => line.trim());
    const messages = lines.map(line => JSON.parse(line));
    return this.processMessages(messages, options);
  }

  convertFromJSON(json, options = {}) {
    const messages = Array.isArray(json) ? json : [json];
    return this.processMessages(messages, options);
  }
  //修复题目找不到
  extractA2UIData(parts) {
    try {
      const result = [];
      const surfaceUpdatePart = parts.find(part => part.kind === 'data' && part.data?.surfaceUpdate);
      if (surfaceUpdatePart) result.push({ surfaceUpdate: surfaceUpdatePart.data.surfaceUpdate });

      const dataModelUpdatePart = parts.find(part => part.kind === 'data' && part.data?.dataModelUpdate);
      if (dataModelUpdatePart) {
        // 直接透传 contents，不要使用 map 过滤，否则 valueMap (题目列表) 会丢失！
        result.push({ 
            dataModelUpdate: dataModelUpdatePart.data.dataModelUpdate 
        });
      }

      const beginRenderingPart = parts.find(part => part.kind === 'data' && part.data?.beginRendering);
      if (beginRenderingPart) result.push({ beginRendering: beginRenderingPart.data.beginRendering });

      return result;
    } catch (error) {
      console.error(`Error extracting A2UI data: ${error.message}`);
      return null;
    }
  }

}

// ============================================================================
// 导出
// ============================================================================

// CommonJS 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { A2UIToHTMLConverter, theme, v0_8 };
}

// 浏览器全局
if (typeof window !== 'undefined') {
  window.A2UIToHTMLConverter = A2UIToHTMLConverter;
  window.a2uiTheme = theme;
}

export { A2UIToHTMLConverter, theme, v0_8 };
