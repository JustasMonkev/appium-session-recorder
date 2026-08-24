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

    it('matches iOS identifiers with the id query strategy', () => {
        dispose = render(() => <MainInspector interaction={action(1)} />, container);
        const strategy = container.querySelector<HTMLSelectElement>('.query-select');
        const input = container.querySelector<HTMLInputElement>('.query-input');
        if (!strategy || !input) throw new Error('Missing query controls');

        strategy.value = 'id';
        strategy.dispatchEvent(new Event('change', { bubbles: true }));
        input.value = 'Login';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        button(container, 'Find').click();

        expect(container.textContent).toContain('Found 1 element(s)');
    });

    it('queries and evaluates stability for HTML identifiers', () => {
        const html = '<!doctype html><html><body><button id=save>Save</button></body></html>';
        const current = action(1, html);
        dispose = render(() => (
            <MainInspector
                interaction={current}
                allActions={[current, action(2, html)]}
                currentIndex={0}
            />
        ), container);
        const strategy = container.querySelector<HTMLSelectElement>('.query-select');
        const input = container.querySelector<HTMLInputElement>('.query-input');
        if (!strategy || !input) throw new Error('Missing query controls');

        strategy.value = 'id';
        strategy.dispatchEvent(new Event('change', { bubbles: true }));
        input.value = 'save';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        button(container, 'Find').click();

        expect(container.textContent).toContain('Found 1 element(s)');
        expect(container.textContent).toContain('Selector Stability');
        expect(container.textContent).toContain('1/1');
    });

    it('hydrates retained future snapshots before stability analysis', async () => {
        const summaries = Array.from({ length: 5 }, (_, index) => ({
            ...action(index + 1),
            source: undefined,
            detailsTruncated: true,
            detailsUrl: `/_recorder/api/interaction/${index + 1}`,
        }));
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async input => {
            const id = Number(String(input).split('/').pop());
            return new Response(JSON.stringify(action(id)));
        });
        vi.stubGlobal('fetch', fetchMock);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');

        stream.emit({ type: 'init', data: summaries });
        button(container, 'Journey').click();
        const firstJourneyStep = container.querySelector<HTMLButtonElement>('.journey-thumb');
        if (!firstJourneyStep) throw new Error('Missing journey step');
        firstJourneyStep.click();
        button(container, 'Inspect').click();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
        await vi.waitFor(() => expect(container.querySelector('.xml-source')?.textContent).toContain('AppiumAUT'));

        const input = container.querySelector<HTMLInputElement>('.query-input');
        if (!input) throw new Error('Missing selector input');
        input.value = 'Login';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        button(container, 'Find').click();

        expect(container.textContent).toContain('Selector Stability');
        expect(container.textContent).toContain('4/4');
        expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
            '/_recorder/api/interaction/2',
            '/_recorder/api/interaction/3',
        ]));
    });

    it('hydrates future details sequentially', async () => {
        let resolveFirst: (response: Response) => void = () => undefined;
        const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve; });
        const fetchMock = vi.fn<typeof fetch>()
            .mockReturnValueOnce(firstResponse)
            .mockResolvedValueOnce(new Response(JSON.stringify(action(4))));
        vi.stubGlobal('fetch', fetchMock);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');

        stream.emit({ type: 'init', data: [action(1), action(2)] });
        button(container, '← Previous').click();
        for (const id of [3, 4]) {
            stream.emit({
                type: 'interaction',
                data: {
                    ...action(id), source: undefined, detailsTruncated: true,
                    detailsUrl: `/_recorder/api/interaction/${id}`,
                },
            });
        }

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenLastCalledWith('/_recorder/api/interaction/3', expect.anything());
        resolveFirst(new Response(JSON.stringify(action(3))));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(fetchMock).toHaveBeenLastCalledWith('/_recorder/api/interaction/4', expect.anything());
    });

    it('does not hydrate beyond the future stability budget', async () => {
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');
        const oversized = `<root>${'x'.repeat(512 * 1024)}</root>`;

        stream.emit({ type: 'init', data: [action(1), action(2, oversized)] });
        button(container, '← Previous').click();
        stream.emit({
            type: 'interaction',
            data: {
                ...action(3), source: undefined, detailsTruncated: true,
                detailsUrl: '/_recorder/api/interaction/3',
            },
        });
        await vi.waitFor(() => expect(container.textContent).toContain('Action 1 of 3'));

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('retries hydration when a newer truncated stream summary wins the race', async () => {
        let resolveFirst: (response: Response) => void = () => undefined;
        const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve; });
        const fetchMock = vi.fn<typeof fetch>()
            .mockReturnValueOnce(firstResponse)
            .mockResolvedValueOnce(new Response(JSON.stringify(action(1, '<root>fresh</root>'))));
        vi.stubGlobal('fetch', fetchMock);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');
        const summary = {
            ...action(1), source: undefined, detailsTruncated: true,
            detailsUrl: '/_recorder/api/interaction/1',
        };

        stream.emit({ type: 'init', data: [summary] });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        stream.emit({ type: 'interaction', data: { ...summary, path: '/newer-summary' } });
        resolveFirst(new Response(JSON.stringify(action(1, '<root>stale</root>'))));

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(container.querySelector('.xml-source')?.textContent).toBe('<root>fresh</root>'));
        expect(container.textContent).not.toContain('<root>stale</root>');
    });

    it('aborts stalled hydration when a newer truncated summary arrives', async () => {
        let firstSignal: AbortSignal | undefined;
        const fetchMock = vi.fn<typeof fetch>()
            .mockImplementationOnce((_input, init) => {
                const signal = init?.signal;
                if (!(signal instanceof AbortSignal)) throw new Error('Expected an abort signal');
                firstSignal = signal;
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            })
            .mockResolvedValueOnce(new Response(JSON.stringify(action(1, '<root>fresh</root>'))));
        vi.stubGlobal('fetch', fetchMock);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');
        const summary = {
            ...action(1), source: undefined, detailsTruncated: true,
            detailsUrl: '/_recorder/api/interaction/1',
        };

        stream.emit({ type: 'init', data: [summary] });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        stream.emit({ type: 'interaction', data: { ...summary, path: '/newer-summary' } });

        await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(container.querySelector('.xml-source')?.textContent).toBe('<root>fresh</root>'));
    });

    it('ignores a stale hydration failure after full stream details arrive', async () => {
        let rejectFetch: (error: Error) => void = () => undefined;
        const pending = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
        const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending);
        vi.stubGlobal('fetch', fetchMock);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');
        const summary = {
            ...action(1), source: undefined, detailsTruncated: true,
            detailsUrl: '/_recorder/api/interaction/1',
        };

        stream.emit({ type: 'init', data: [summary] });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        stream.emit({ type: 'interaction', data: action(1, '<root>stream details</root>') });
        rejectFetch(new Error('stale request failed'));

        await vi.waitFor(() => expect(container.querySelector('.xml-source')?.textContent).toBe('<root>stream details</root>'));
        expect(container.textContent).not.toContain('Interaction details unavailable.');
    });

    it('retries a stale hydration failure for a newer truncated summary', async () => {
        let rejectFirst: (error: Error) => void = () => undefined;
        const first = new Promise<Response>((_resolve, reject) => { rejectFirst = reject; });
        const fetchMock = vi.fn<typeof fetch>()
            .mockReturnValueOnce(first)
            .mockResolvedValueOnce(new Response(JSON.stringify(action(1, '<root>retry success</root>'))));
        vi.stubGlobal('fetch', fetchMock);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');
        const summary = {
            ...action(1), source: undefined, detailsTruncated: true,
            detailsUrl: '/_recorder/api/interaction/1',
        };

        stream.emit({ type: 'init', data: [summary] });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        stream.emit({ type: 'interaction', data: { ...summary, path: '/newer-summary' } });
        rejectFirst(new Error('stale request failed'));

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(container.querySelector('.xml-source')?.textContent).toBe('<root>retry success</root>'));
        expect(container.textContent).not.toContain('Interaction details unavailable.');
    });

    it('reports a truncated summary without a detail URL without retrying', async () => {
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');

        stream.emit({
            type: 'init',
            data: [{ ...action(1), source: undefined, detailsTruncated: true, detailsUrl: undefined }],
        });

        await vi.waitFor(() => expect(container.textContent).toContain('Interaction details unavailable.'));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not let skipped captures consume future hydration slots', async () => {
        const skipped = Array.from({ length: 10 }, (_, index) => ({
            ...action(index + 2), source: undefined, detailsTruncated: false,
        }));
        const future = {
            ...action(12), source: undefined, detailsTruncated: true,
            detailsUrl: '/_recorder/api/interaction/12',
        };
        const trailing = Array.from({ length: 8 }, (_, index) => action(index + 13));
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify(action(12, '<root>hydrated future</root>'))),
        );
        vi.stubGlobal('fetch', fetchMock);
        dispose = render(() => <App />, container);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');

        stream.emit({ type: 'init', data: [action(1), ...skipped, future, ...trailing] });
        expect(fetchMock).not.toHaveBeenCalled();
        button(container, 'Journey').click();
        const firstJourneyStep = container.querySelector<HTMLButtonElement>('.journey-thumb');
        if (!firstJourneyStep) throw new Error('Missing journey step');
        firstJourneyStep.click();

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
            '/_recorder/api/interaction/12',
            expect.objectContaining({ credentials: 'same-origin' }),
        ));
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
        expect(container.textContent).toContain('Interaction details are required to view page source.');
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

        expect(container.textContent).toContain('Page source is too large to display or inspect.');
        expect(container.textContent).not.toContain('x'.repeat(1_000));
    });

    it('styles a deleted blank line as a deletion', () => {
        const previous = action(1, '<root>text\n\n<child/></root>');
        const current = action(2, '<root>text\n<child/></root>');
        dispose = render(() => <DiffPanel current={current} previous={previous} />, container);

        expect(container.querySelectorAll('.diff-row-deleted')).toHaveLength(1);
    });
});
