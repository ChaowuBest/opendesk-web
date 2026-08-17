import { jest } from '@jest/globals';
import { createSlidesSelectionInputRequest } from '../../../renderer/applications/office/slidesSelectionInput.js';

describe('slides selection input request', () => {
    test('turns selected slide elements into a generic input request', () => {
        const translate = jest.fn((_key: string, params?: Record<string, string | number>) => {
            return `请编辑第 ${params?.page} 页：`;
        });

        const request = createSlidesSelectionInputRequest(
            {
                slideIndex: 1,
                selectedElements: [
                    {
                        id: 'title-1',
                        type: 'text',
                        text: '  季度   总结  ',
                        x: 10.2,
                        y: 20.6,
                        width: 300.4,
                        height: 80.5
                    }
                ]
            },
            translate
        );

        expect(translate).toHaveBeenCalledWith('renderer.fileExplorer.pptx.ai.selectionPrompt', { page: 2 });
        expect(request).toEqual({
            type: 'insert-text',
            placement: 'append',
            focus: true,
            text: '请编辑第 2 页：\n- text (title-1) @ (10, 21) 300×81: “季度 总结”'
        });
    });
});
