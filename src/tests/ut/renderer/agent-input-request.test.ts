import { parseHTML } from 'linkedom';
import {
    applyAgentInputRequest,
    dispatchAgentInputRequest,
    listenForAgentInputRequests
} from '../../../renderer/input/agentInputRequest.js';

describe('agent input requests', () => {
    test('appends requested text to the current input and focuses it', () => {
        const input = {
            value: '已有问题',
            focused: false,
            getCurrentText() {
                return this.value;
            },
            setText(value: string) {
                this.value = value;
            },
            focus() {
                this.focused = true;
            }
        };

        applyAgentInputRequest(input, {
            type: 'insert-text',
            text: '补充上下文',
            placement: 'append',
            focus: true
        });

        expect(input.value).toBe('已有问题\n\n补充上下文');
        expect(input.focused).toBe(true);
    });

    test('inserts requested text directly when the current input is empty', () => {
        const input = {
            value: '',
            getCurrentText() {
                return this.value;
            },
            setText(value: string) {
                this.value = value;
            }
        };

        applyAgentInputRequest(input, {
            type: 'insert-text',
            text: '新的上下文',
            placement: 'append'
        });

        expect(input.value).toBe('新的上下文');
    });

    test('routes a generic request from a child to its input host', () => {
        const { window } = parseHTML('<!doctype html><html><body><section><button></button></section></body></html>');
        Object.assign(globalThis, { CustomEvent: window.CustomEvent });
        const host = window.document.querySelector('section')!;
        const source = window.document.querySelector('button')!;
        const input = {
            value: '',
            getCurrentText() {
                return this.value;
            },
            setText(value: string) {
                this.value = value;
            }
        };
        const disconnect = listenForAgentInputRequests(host, () => input);

        dispatchAgentInputRequest(source, {
            type: 'insert-text',
            text: '来自应用的上下文',
            placement: 'append'
        });

        expect(input.value).toBe('来自应用的上下文');
        disconnect();
    });
});
