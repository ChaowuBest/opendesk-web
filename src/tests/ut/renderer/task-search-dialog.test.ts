import { afterEach, beforeAll, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { TaskSearchDialog } from '../../../renderer/components/taskSearchDialog.js';

let dialog: TaskSearchDialog;
let indexChanged: (unavailable?: boolean) => void;
beforeAll(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement });
    Object.assign(window.HTMLElement.prototype, {
        showModal() {
            this.setAttribute('open', '');
        },
        close() {
            this.removeAttribute('open');
        }
    });
});
afterEach(() => {
    dialog?.destroy();
    jest.useRealTimers();
});
const hit = (id: string) => ({
    taskId: id,
    title: '历史任务',
    workspace: '/work/OpenDesk',
    snippet: '创建内容',
    messageId: 'm1',
    priority: 0
});
const response = (id: string) => ({ items: [hit(id)], hasMore: false, indexing: false, failedTasks: 0 });
const setup = (search: any) => {
    dialog = new TaskSearchDialog({
        getTasks: () => [
            { task_id: 'one', task_name: 'one' },
            { task_id: 'two', task_name: 'two' }
        ],
        search,
        subscribe: (callback) => {
            indexChanged = callback;
            return () => {
                indexChanged = () => {};
            };
        },
        open: async () => {},
        translate: (key) => key
    });
    dialog.show();
    return document.querySelector('dialog input') as HTMLInputElement;
};
const input = (element: HTMLInputElement, value: string) => {
    element.value = value;
    element.dispatchEvent(new window.Event('input'));
};
test('ignores old requests and highlights the current query', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    let first: (value: any) => void;
    const search = jest
        .fn<any>()
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    first = resolve;
                })
        )
        .mockResolvedValue(response('two'));
    const element = setup(search);
    input(element, 'first');
    jest.advanceTimersByTime(150);
    input(element, '创建');
    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
    first!(response('one'));
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('[data-task-id="two"]')).not.toBeNull();
    expect(document.querySelector('[data-task-id="one"]')).toBeNull();
    expect(document.querySelector('dialog mark')?.textContent).toBe('创建');
});
test('does not search while composing and stops querying after closing', () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    const search = jest.fn<any>().mockResolvedValue(response('one'));
    const element = setup(search);
    element.dispatchEvent(new window.Event('compositionstart'));
    input(element, 'chuang');
    jest.advanceTimersByTime(500);
    expect(search).not.toHaveBeenCalled();
    element.value = '创建';
    element.dispatchEvent(new window.Event('compositionend'));
    dialog.hide();
    jest.advanceTimersByTime(500);
    expect(search).not.toHaveBeenCalled();
});

test('shows cached results immediately while refreshing, then ends loading', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    let complete: (value: any) => void;
    const search = jest
        .fn<any>()
        .mockResolvedValueOnce(response('one'))
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                })
        );
    const element = setup(search);
    input(element, '创建');
    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
    dialog.hide();
    dialog.show();
    expect(document.querySelector('[data-task-id="one"]')).not.toBeNull();
    expect((document.querySelector('.od-task-search-spinner') as HTMLElement).hidden).toBe(false);
    jest.advanceTimersByTime(150);
    complete!(response('two'));
    await Promise.resolve();
    await Promise.resolve();
    expect((document.querySelector('.od-task-search-spinner') as HTMLElement).hidden).toBe(true);
    expect(document.querySelector('[data-task-id="one"]')).toBeNull();
    expect(document.querySelector('[data-task-id="two"]')).not.toBeNull();
});

test('keeps partial results actionable and distinguishes incomplete coverage from no matches', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    const search = jest.fn<any>().mockResolvedValue({ ...response('one'), indexing: true });
    const element = setup(search);
    input(element, '创建');
    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
    expect((document.querySelector('[data-task-id="one"]') as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('.od-task-search-status')?.textContent).toBe('renderer.taskSearch.indexing');
    search.mockResolvedValue({ ...response('one'), items: [], failedTasks: 1 });
    indexChanged();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('.od-task-search-status')?.textContent).toBe('renderer.taskSearch.incomplete');
    indexChanged(true);
    expect(document.querySelector('.od-task-search-status')?.textContent).toContain('renderer.taskSearch.error');
    expect((document.querySelector('.od-task-search-spinner') as HTMLElement).hidden).toBe(true);
});

test('preserves a live title match before its first save has reached the index', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    const search = jest.fn<any>().mockResolvedValue({ ...response('one'), items: [] });
    const element = setup(search);
    input(element, 'one');
    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('[data-task-id="one"]')).not.toBeNull();
    expect(document.querySelector('.od-task-search-status')?.textContent).toBe('');
});

test('list updates cannot postpone a query and index changes refresh without polling', async () => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    const search = jest.fn<any>().mockResolvedValue(response('one'));
    const element = setup(search);
    input(element, '创建');
    for (let i = 0; i < 20; i++) {
        jest.advanceTimersByTime(100);
        document.dispatchEvent(new window.Event('task-list-updated'));
        await Promise.resolve();
        await Promise.resolve();
    }
    expect(search).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-task-id="one"]')).not.toBeNull();
    jest.advanceTimersByTime(60000);
    expect(search).toHaveBeenCalledTimes(1);
    search.mockResolvedValue(response('two'));
    indexChanged();
    await Promise.resolve();
    await Promise.resolve();
    expect(search).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-task-id="two"]')).not.toBeNull();
    dialog.hide();
    indexChanged();
    expect(search).toHaveBeenCalledTimes(2);
});
