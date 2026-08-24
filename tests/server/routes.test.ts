import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createRoutes } from '../../src/server/routes';
import { InteractionRecorder } from '../../src/server/interaction-recorder';

function recordOf(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Expected an object');
    }
    return Object.fromEntries(Object.entries(value));
}

function portOf(server: Server): number {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an IP socket address');
    return address.port;
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections?.();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

class EventStream {
    private readonly reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel'>;
    private readonly decoder = new TextDecoder();
    private buffer = '';

    constructor(response: Response) {
        if (!response.body) throw new Error('SSE response had no body');
        this.reader = response.body.getReader();
    }

    async nextFrame(): Promise<string> {
        while (!this.buffer.includes('\n\n')) {
            const chunk = await this.reader.read();
            if (chunk.done) throw new Error('SSE stream ended before the next event');
            this.buffer += this.decoder.decode(chunk.value, { stream: true });
        }
        const boundary = this.buffer.indexOf('\n\n') + 2;
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary);
        return frame;
    }

    async next(): Promise<Record<string, unknown>> {
        return recordOf(JSON.parse((await this.nextFrame()).replace(/^data: /, '').trimEnd()));
    }

    async cancel(): Promise<void> {
        await this.reader.cancel();
    }
}

describe('recorder routes over HTTP', () => {
    let recorder: InteractionRecorder;
    let server: Server;
    let baseUrl: string;
    let viewerDir: string;

    beforeEach(async () => {
        recorder = new InteractionRecorder();
        viewerDir = await mkdtemp(join(tmpdir(), 'appium-recorder-routes-'));
        await writeFile(join(viewerDir, 'index.html'), '<!doctype html><title>Recorder fixture</title>');
        const app = express();
        app.use(createRoutes(recorder, viewerDir));
        server = createServer(app);
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        baseUrl = `http://127.0.0.1:${portOf(server)}`;
    });

    afterEach(async () => {
        await close(server);
        await rm(viewerDir, { recursive: true, force: true });
    });

    async function openStream(): Promise<{ response: Response; stream: EventStream }> {
        const response = await fetch(`${baseUrl}/_recorder/api/stream`);
        expect(response.status).toBe(200);
        return { response, stream: new EventStream(response) };
    }

    it('returns an empty history', async () => {
        const response = await fetch(`${baseUrl}/_recorder/api/history`);
        expect(await response.json()).toEqual([]);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('returns recorded interactions in order', async () => {
        recorder.recordInteraction({ method: 'POST', path: '/first' });
        recorder.recordInteraction({ method: 'POST', path: '/second' });

        await expect(fetch(`${baseUrl}/_recorder/api/history`).then(response => response.json()))
            .resolves.toMatchObject([{ path: '/first' }, { path: '/second' }]);
    });

    it('clears history', async () => {
        recorder.recordInteraction({ method: 'POST', path: '/action' });

        const response = await fetch(`${baseUrl}/_recorder/api/history`, { method: 'DELETE' });
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await response.json()).toEqual({ ok: true });
        expect(recorder.getHistory()).toEqual([]);
    });

    it('sets SSE headers and sends current history on connection', async () => {
        recorder.recordInteraction({ method: 'POST', path: '/existing' });
        const { response, stream } = await openStream();

        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await stream.next()).toMatchObject({ type: 'init', data: [{ path: '/existing' }] });
        await stream.cancel();
    });

    it('streams new interactions and captured-state updates', async () => {
        const { stream } = await openStream();
        await stream.next();

        const interaction = recorder.recordInteraction({ method: 'POST', path: '/new' });
        recorder.attachCapturedState(interaction.id, {
            screenshot: Buffer.from('png').toString('base64'),
            source: '<screen />',
        });

        expect(await stream.next()).toMatchObject({ type: 'interaction', data: { path: '/new' } });
        expect(await stream.next()).toMatchObject({ type: 'interaction', data: { source: '<screen />' } });
        await stream.cancel();
    });

    it('streams clear events', async () => {
        const { stream } = await openStream();
        await stream.next();

        recorder.clearHistory();

        expect(await stream.next()).toEqual({ type: 'clear', data: null });
        await stream.cancel();
    });

    it('accepts a replacement after an SSE client disconnects', async () => {
        const first = await openStream();
        await first.stream.next();
        await first.stream.cancel();
        recorder.recordInteraction({ method: 'POST', path: '/after-close' });

        const replacement = await openStream();
        expect(await replacement.stream.next()).toMatchObject({
            type: 'init',
            data: [{ path: '/after-close' }],
        });
        await replacement.stream.cancel();
    });

    it('continues after an initial SSE write encounters real socket backpressure', async () => {
        for (let index = 0; index < 500; index++) {
            recorder.recordInteraction({ method: 'POST', path: `/${index}/${'p'.repeat(2_000)}` });
        }
        const { stream } = await openStream();
        recorder.recordInteraction({ method: 'POST', path: '/after-initial-write' });

        expect((await stream.next()).type).toBe('init');
        expect(await stream.next()).toMatchObject({
            type: 'interaction',
            data: { path: '/after-initial-write' },
        });
        await stream.cancel();
    });

    it('queues later SSE events until a paused real client drains', async () => {
        const { stream } = await openStream();
        await stream.next();
        const ids: number[] = [];
        for (let index = 0; index < 3; index++) {
            const interaction = recorder.recordInteraction({ method: 'POST', path: `/${index}` });
            ids.push(interaction.id);
            recorder.attachCapturedState(interaction.id, {
                source: `<Root>${'x'.repeat(512 * 1024)}</Root>`,
            });
        }

        const received: number[] = [];
        for (let index = 0; index < 6; index++) {
            const event = await stream.next();
            const data = recordOf(event.data);
            if (data.source) received.push(Number(data.id));
        }
        expect(received).toEqual(ids);
        await stream.cancel();
    });

    it('caps active SSE clients and accepts a replacement after disconnect', async () => {
        const connections = await Promise.all(Array.from({ length: 32 }, openStream));
        expect((await fetch(`${baseUrl}/_recorder/api/stream`)).status).toBe(429);

        await connections[0].stream.cancel();
        let replacement: Response | undefined;
        await vi.waitFor(async () => {
            replacement = await fetch(`${baseUrl}/_recorder/api/stream`);
            expect(replacement.status).toBe(200);
        });
        await replacement?.body?.cancel();
        await Promise.all(connections.slice(1).map(connection => connection.stream.cancel()));
    });

    it('bounds the initial SSE history payload while preserving every interaction id', async () => {
        for (let index = 0; index < 3; index++) {
            recorder.recordInteraction({ method: 'POST', path: `/${index}` });
        }
        const { stream } = await openStream();
        const frame = await stream.nextFrame();
        const event = recordOf(JSON.parse(frame.replace(/^data: /, '').trimEnd()));
        const data = event.data;
        if (!Array.isArray(data)) throw new TypeError('Expected initial interactions');

        expect(data.map(interaction => recordOf(interaction).id)).toEqual([1, 2, 3]);
        expect(data.every(interaction => recordOf(interaction).detailsTruncated === true)).toBe(true);
        expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(2 * 1024 * 1024);
        await stream.cancel();
    });

    it('serves stored screenshots with private no-store PNG headers', async () => {
        const interaction = recorder.recordInteraction({ method: 'POST', path: '/action' });
        recorder.attachCapturedState(interaction.id, {
            screenshot: Buffer.from('png-bytes').toString('base64'),
        });

        const response = await fetch(`${baseUrl}/_recorder/api/screenshot/${interaction.id}`);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('png-bytes'));
    });

    it.each(['1e2', '0x64', '000100'])('rejects a non-canonical screenshot id alias: %s', async id => {
        let interaction;
        for (let index = 0; index < 100; index++) {
            interaction = recorder.recordInteraction({ method: 'POST', path: `/${index}` });
        }
        if (!interaction) throw new Error('Expected interaction 100');
        recorder.attachCapturedState(interaction.id, {
            screenshot: Buffer.from('png').toString('base64'),
        });

        const response = await fetch(`${baseUrl}/_recorder/api/screenshot/${id}`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Screenshot not found' });
    });

    it.each(['999', 'invalid'])('returns 404 for missing screenshot id %s', async id => {
        expect((await fetch(`${baseUrl}/_recorder/api/screenshot/${id}`)).status).toBe(404);
    });

    it('serves the viewer entry point from a real file', async () => {
        const response = await fetch(`${baseUrl}/_recorder`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('<title>Recorder fixture</title>');
    });

    it('formats every SSE message as a valid JSON data record', async () => {
        recorder.recordInteraction({ method: 'POST', path: '/action' });
        const { stream } = await openStream();
        const frame = await stream.nextFrame();

        expect(frame).toMatch(/^data: .+\n\n$/s);
        expect(() => JSON.parse(frame.replace(/^data: /, '').trimEnd())).not.toThrow();
        await stream.cancel();
    });

    it('streams to multiple clients independently', async () => {
        const first = await openStream();
        const second = await openStream();
        await first.stream.next();
        await second.stream.next();

        recorder.recordInteraction({ method: 'POST', path: '/both' });
        expect(await first.stream.next()).toMatchObject({ data: { path: '/both' } });
        expect(await second.stream.next()).toMatchObject({ data: { path: '/both' } });

        await first.stream.cancel();
        recorder.recordInteraction({ method: 'POST', path: '/second-only' });
        expect(await second.stream.next()).toMatchObject({ data: { path: '/second-only' } });
        await second.stream.cancel();
    });
});
