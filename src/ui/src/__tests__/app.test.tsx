import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from '../App';
import { MainInspector } from '../components/MainInspector';
import { SelectorStability } from '../components/SelectorStability';
import { JourneyPanel } from '../components/JourneyPanel';
import { DiffPanel } from '../components/DiffPanel';
import type { Interaction } from '../types';
import { parseXmlSource } from '../utils/xml-parser';

class FakeEventSource {
    static instance: FakeEventSource | undefined;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(readonly url: string) {
        FakeEventSource.instance = this;
    }

    close(): void {}

    emit(event: unknown): void {
        this.onmessage?.({ data: JSON.stringify(event) });
    }
}

const source = `
    <AppiumAUT type="XCUIElementTypeApplication">
        <XCUIElementTypeButton type="XCUIElementTypeButton" name="Login" label="Log In"
            enabled="true" visible="true" clickable="true" />
    </AppiumAUT>
`;

function action(id: number, xml = source): Interaction {
    return {
        id,
        timestamp: `2026-01-01T00:00:0${id}.000Z`,
        method: 'POST',
        path: `/session/one/element/${id}/click`,
        screenshotUrl: `/_recorder/api/screenshot/${id}`,
        source: xml,
        actionKind: 'tap',
    };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button'))
        .find(candidate => candidate.textContent?.trim() === label);
    if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing button "${label}"`);
    return found;
}

describe('viewer integration', () => {
    let container: HTMLDivElement;
    let dispose: (() => void) | undefined;

    beforeEach(() => {
        FakeEventSource.instance = undefined;
        vi.stubGlobal('EventSource', FakeEventSource);
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(() => {
        dispose?.();
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('follows the latest action until the user navigates away from the tail', () => {
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');

        stream.emit({ type: 'init', data: [action(1), action(2)] });
        expect(container.textContent).toContain('Action 2 of 2');

        button(container, '← Previous').click();
        expect(container.textContent).toContain('Action 1 of 2');

        stream.emit({ type: 'interaction', data: action(3) });
        expect(container.textContent).toContain('Action 1 of 3');

        stream.emit({ type: 'evict', data: { ids: [1] } });
        expect(container.textContent).toContain('Action 1 of 2');
        expect(container.textContent).toContain('#2');

        stream.emit({ type: 'clear', data: null });
        expect(container.textContent).toContain('No actions recorded yet');
    });

    it('queries elements and switches among inspect, diff, and journey views', () => {
        const previous = action(1, '<AppiumAUT type="XCUIElementTypeApplication" />');
        const current = action(2);
        const next = action(3);
        dispose = render(() => (
            <MainInspector
                interaction={current}
                previousInteraction={previous}
                allActions={[current, next]}
                currentIndex={0}
            />
        ), container);

        const input = container.querySelector<HTMLInputElement>('.query-input');
        if (!input) throw new Error('Missing selector input');
        input.value = 'Login';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        button(container, 'Find').click();

        expect(container.textContent).toContain('Found 1 element(s)');
        expect(container.textContent).toContain('Selector Stability');
        expect(container.textContent).toContain('accessibility id');

        button(container, 'Diff').click();
        expect(container.textContent).toContain('Diff (Previous → Current)');

        button(container, 'Journey').click();
        expect(container.textContent).toContain('All Screens');
        expect(container.textContent).toContain('Action 1 of 2');
    });

    it('preserves significant whitespace in exact selector queries', () => {
        const xml = '<hierarchy><node class="android.widget.Button" content-desc=" Login "/></hierarchy>';
        dispose = render(() => <MainInspector interaction={action(1, xml)} />, container);
        const input = container.querySelector<HTMLInputElement>('.query-input');
        if (!input) throw new Error('Missing selector input');

        input.value = ' Login ';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        button(container, 'Find').click();

        expect(container.textContent).toContain('Found 1 element(s)');
    });

    it('bounds selector stability work across maximum-size future screens', () => {
        const selected = parseXmlSource('<hierarchy><node class="android.widget.Button" content-desc="target" /></hierarchy>')[1];
        const largeSource = `<hierarchy><node class="android.widget.Button" content-desc="target" />${
            '<node class="android.view.View" />'.repeat(898)
        }</hierarchy>`;
        const futureActions = [1, 2, 3].map(id => action(id, largeSource));

        dispose = render(() => (
            <SelectorStability
                selectedElement={selected}
                locators={[{ strategy: 'accessibility id', value: 'target', platform: 'android' }]}
                futureActions={futureActions}
            />
        ), container);

        expect(container.textContent).toContain('Analysis limited to 2/3 future screens.');
        expect(container.textContent).toContain('2/2');
    });

    it('does not present a future journey step as current while a leading find is selected', () => {
        const find = { ...action(1), actionKind: 'find' as const };
        const tap = action(2);
        dispose = render(() => (
            <JourneyPanel actions={[find, tap]} currentIndex={0} />
        ), container);

        expect(container.textContent).toContain('No journey screenshots available yet.');
        expect(container.textContent).not.toContain('Action 1 of 1');
    });

    it('does not present failed captures as blank journey screens', () => {
        const failed = { ...action(1), screenshotUrl: undefined, captureStatus: 'failed' as const };
        dispose = render(() => (
            <JourneyPanel actions={[failed]} currentIndex={0} />
        ), container);

        expect(container.textContent).toContain('No journey screenshots available yet.');
    });

    it('reports future stability snapshots that are unavailable or exceed the source budget', () => {
        const selected = parseXmlSource('<hierarchy><node class="android.widget.Button" content-desc="target" /></hierarchy>')[1];
        const unavailable = { ...action(1), source: undefined, detailsTruncated: true };
        const tooLarge = action(2, `<hierarchy>${'x'.repeat(512 * 1024)}</hierarchy>`);
        dispose = render(() => (
            <SelectorStability
                selectedElement={selected}
                locators={[{ strategy: 'accessibility id', value: 'target', platform: 'android' }]}
                futureActions={[unavailable, tooLarge]}
            />
        ), container);

        expect(container.textContent).toContain('Analysis limited to 0/2 future screens.');
    });

    it('offers a visible retry after detail hydration fails', async () => {
        const fetchMock = vi.fn<typeof fetch>()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(new Response(JSON.stringify(action(1, '<root>hydrated</root>')), {
                headers: { 'content-type': 'application/json' },
            }));
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');

        stream.emit({
            type: 'init',
            data: [{
                ...action(1),
                source: undefined,
                screenshotUrl: undefined,
                detailsTruncated: true,
                detailsUrl: '/_recorder/api/interaction/1',
            }],
        });

        await vi.waitFor(() => expect(container.textContent).toContain('Interaction details unavailable.'));
        expect(container.textContent).toContain('Interaction details are required to view XML.');
        expect(container.querySelector('.xml-source')).toBeNull();
        button(container, 'Retry').click();
        await vi.waitFor(() => expect(container.querySelector('.xml-source')?.textContent).toBe('<root>hydrated</root>'));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('offers a diff retry when only previous detail hydration fails', async () => {
        const previous = {
            ...action(1), source: undefined, detailsTruncated: true,
            detailsUrl: '/_recorder/api/interaction/1',
        };
        const current = {
            ...action(2), source: undefined, detailsTruncated: true,
            detailsUrl: '/_recorder/api/interaction/2',
        };
        let previousAvailable = false;
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async input => {
            if (String(input).endsWith('/1')) {
                if (!previousAvailable) throw new Error('previous unavailable');
                return new Response(JSON.stringify(action(1, '<root/>')));
            }
            return new Response(JSON.stringify(action(2, '<root><current/></root>')));
        });
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');

        stream.emit({ type: 'init', data: [previous, current] });
        button(container, 'Diff').click();
        await vi.waitFor(() => expect(container.textContent).toContain('Previous interaction details unavailable.'));

        previousAvailable = true;
        button(container, 'Retry').click();
        await vi.waitFor(() => expect(container.textContent).toContain('Diff (Previous → Current)'));
        await vi.waitFor(() => expect(container.textContent).not.toContain('Previous interaction details unavailable.'));
        expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/1')).length).toBeGreaterThanOrEqual(2);
    });

    it('does not parse or render an oversized inspector source', () => {
        const oversized = `<root>${'x'.repeat(512 * 1024)}</root>`;
        dispose = render(() => <MainInspector interaction={action(1, oversized)} />, container);

        expect(container.textContent).toContain('XML source is too large to display or inspect.');
        expect(container.textContent).not.toContain('x'.repeat(1_000));
    });

    it('styles a deleted blank line as a deletion', () => {
        const previous = action(1, '<root>text\n\n<child/></root>');
        const current = action(2, '<root>text\n<child/></root>');
        dispose = render(() => <DiffPanel current={current} previous={previous} />, container);

        expect(container.querySelectorAll('.diff-row-deleted')).toHaveLength(1);
    });
});
