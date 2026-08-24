import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectToStream, fetchInteraction, parseStreamEvent } from '../api';

const interaction = {
    id: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    method: 'POST',
    path: '/session/one/back',
};

class FakeEventSource {
    static instance: FakeEventSource | undefined;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    closed = false;

    constructor(readonly url: string) {
        FakeEventSource.instance = this;
    }

    close(): void {
        this.closed = true;
    }

    emitMessage(data: string): void {
        this.onmessage?.({ data });
    }
}

describe('parseStreamEvent', () => {
    it.each([
        { type: 'init', data: [interaction] },
        { type: 'interaction', data: interaction },
        { type: 'clear', data: null },
        { type: 'evict', data: { ids: [1, 2] } },
    ])('accepts valid event $type', event => {
        expect(parseStreamEvent(JSON.stringify(event))).toEqual({ ok: true, event });
    });

    it.each([
        'not JSON',
        '[]',
        '{}',
        '{"type":"interaction","data":{"id":"1"}}',
        '{"type":"init","data":[{"id":1}]}',
        '{"type":"clear","data":[]}',
        '{"type":"evict","data":{"ids":[1.5]}}',
        '{"type":"evict","data":{"ids":["1"]}}',
        JSON.stringify({ type: 'interaction', data: { ...interaction, id: 0 } }),
        JSON.stringify({ type: 'interaction', data: { ...interaction, source: 123 } }),
        JSON.stringify({ type: 'interaction', data: { ...interaction, screenshotUrl: false } }),
        JSON.stringify({ type: 'interaction', data: { ...interaction, detailsUrl: 1 } }),
        JSON.stringify({ type: 'interaction', data: { ...interaction, detailsTruncated: 'true' } }),
        JSON.stringify({ type: 'interaction', data: { ...interaction, elementInfo: { using: 'id' } } }),
        JSON.stringify({ type: 'interaction', data: { ...interaction, actionKind: 'delete' } }),
        JSON.stringify({ type: 'interaction', data: { ...interaction, captureStatus: 'done' } }),
        JSON.stringify({ type: 'evict', data: { ids: [0] } }),
    ])('rejects malformed event %s', serialized => {
        expect(parseStreamEvent(serialized)).toEqual({ ok: false });
    });
});

describe('connectToStream', () => {
    beforeEach(() => {
        FakeEventSource.instance = undefined;
        vi.stubGlobal('EventSource', FakeEventSource);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('delivers valid events and closes the stream', () => {
        const listener = vi.fn();
        const disconnect = connectToStream(listener);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');

        stream.emitMessage(JSON.stringify({ type: 'interaction', data: interaction }));
        disconnect();

        expect(stream.url).toBe('/_recorder/api/stream');
        expect(listener).toHaveBeenCalledWith({ type: 'interaction', data: interaction });
        expect(stream.closed).toBe(true);
    });

    it('reports malformed events without delivering them', () => {
        const listener = vi.fn();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        connectToStream(listener);
        const stream = FakeEventSource.instance;
        if (!stream) throw new Error('Expected an EventSource instance');

        stream.emitMessage('{broken');

        expect(listener).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith('Invalid SSE event');
    });
});

describe('fetchInteraction', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('loads a validated same-origin interaction', async () => {
        const controller = new AbortController();
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(interaction)));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchInteraction('/_recorder/api/interaction/1', controller.signal)).resolves.toEqual(interaction);
        expect(fetchMock).toHaveBeenCalledWith('/_recorder/api/interaction/1', {
            signal: controller.signal,
            credentials: 'same-origin',
        });
    });

    it.each([
        'https://attacker.example/interaction/1',
        '/_recorder/api/interaction/0',
        '/_recorder/api/interaction/1?token=secret',
        '/_recorder/api/interaction/01',
    ])('rejects an unsafe detail URL %s before fetching', async url => {
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchInteraction(url)).rejects.toThrow('Invalid interaction details URL');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports HTTP, network, and malformed payload failures', async () => {
        const fetchMock = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(new Response('', { status: 404 }))
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(new Response('{}'))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...interaction, id: 2 })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...interaction, detailsTruncated: true })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...interaction, source: 123 })));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchInteraction('/_recorder/api/interaction/1')).rejects.toThrow('(404)');
        await expect(fetchInteraction('/_recorder/api/interaction/1')).rejects.toThrow('offline');
        await expect(fetchInteraction('/_recorder/api/interaction/1')).rejects.toThrow('response was invalid');
        await expect(fetchInteraction('/_recorder/api/interaction/1')).rejects.toThrow('response was invalid');
        await expect(fetchInteraction('/_recorder/api/interaction/1')).rejects.toThrow('response was invalid');
        await expect(fetchInteraction('/_recorder/api/interaction/1')).rejects.toThrow('response was invalid');
    });
});
