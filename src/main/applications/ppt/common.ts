/** 幻灯片定义：与 data/<id>/manifest.json 结构一致；pages 为每页的原始 HTML 字符串 */
export interface Slides {
    uid: string;
    name: string;
    abstract: string;
    /** 每页的完整 HTML 内容，用于 Shadow DOM 展示 */
    pages: string[];
    images: Record<string, string>;
}
