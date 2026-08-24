import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { createConnection } from 'node:net';
import express from 'express';
import { createServer, startServer } from '../../src/server/server';
import { createAppiumProxy } from '../../src/server/proxy-middleware';
import { httpHost, type RecorderOptions } from '../../src/server/types';

function portOf(server: Server): number {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an IP socket address');
    return address.port;
}

function recordOf(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Expected a JSON object');
    }
    return Object.fromEntries(Object.entries(value));
}

async function listen(server: Server): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return portOf(server);
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections?.();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

async function requestStatus(port: number, headers: Record<string, string>): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const outgoing = request({
            hostname: '127.0.0.1',
            port,
            path: '/_recorder/api/history',
            headers,
        }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
        });
        outgoing.on('error', reject);
        outgoing.end();
    });
}

function recorderHttp(options: RecorderOptions = {}) {
    const recorder = createServer(options);
    const server = createHttpServer(recorder.app);
    server.on('upgrade', recorder.handleUpgrade);
    return { ...recorder, server };
}

async function rawUpgrade(port: number, origin: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        let response = '';
        const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('Timed out waiting for upgrade response'));
        }, 2_000);
        socket.setEncoding('utf8');
        socket.on('error', reject);
        socket.on('data', chunk => {
            response += chunk;
            if (!response.includes('\r\n\r\n')) return;
            clearTimeout(timeout);
            socket.destroy();
            resolve(response);
        });
        socket.on('connect', () => {
            socket.write([
                'GET /session/session-1/bidi HTTP/1.1',
                `Host: 127.0.0.1:${port}`,
                'Connection: Upgrade',
                'Upgrade: websocket',
                `Origin: ${origin}`,
                '',
                '',
            ].join('\r\n'));
        });
    });
}

async function readFirstSseEvent(response: Response): Promise<Record<string, unknown>> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE stream ended before its first event');
        buffer += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    return JSON.parse(buffer.slice(0, buffer.indexOf('\n\n')).replace(/^data: /, ''));
}

describe('recorder server integration', () => {
    const servers: Server[] = [];

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(close));
        vi.restoreAllMocks();
    });

    it('allows loopback requests and rejects foreign Host and Origin values', async () => {
        const { server } = recorderHttp({ appiumUrl: 'http://127.0.0.1:4723' });
        servers.push(server);
        const port = await listen(server);
        const url = `http://127.0.0.1:${port}/_recorder/api/history`;

        await expect(fetch(url).then(response => response.json())).resolves.toEqual([]);

        expect(await requestStatus(port, { host: 'attacker.example' })).toBe(403);

        const foreignOrigin = await fetch(url, { headers: { origin: 'https://attacker.example' } });
        expect(foreignOrigin.status).toBe(403);

        const loopbackOrigin = await fetch(url, { headers: { origin: 'http://localhost:3000' } });
        expect(loopbackOrigin.status).toBe(200);
    });

    it('rejects non-loopback bind configuration', () => {
        expect(() => createServer({ host: '0.0.0.0' })).toThrow('Recorder host must be localhost');
        expect(() => createServer({ host: '' })).toThrow('Recorder host must be localhost');
        expect(() => createServer({ host: '[::1]' })).toThrow('Recorder host must be localhost');
        const untypedCreateServer: unknown = createServer;
        if (typeof untypedCreateServer !== 'function') throw new TypeError('Expected createServer to be callable');
        expect(() => untypedCreateServer({ host: 123 })).toThrow('Recorder host must be localhost');
    });

    it('starts silently on the requested loopback address and formats IPv6 URLs', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const server = await startServer({ host: '127.0.0.1', port: 0 });
        servers.push(server);
        const address = server.address();

        expect(address && typeof address !== 'string' ? address.address : undefined).toBe('127.0.0.1');
        expect(log).not.toHaveBeenCalled();
        expect(httpHost('::1')).toBe('[::1]');
        expect(new URL(`http://${httpHost('::1')}:4724`).hostname).toBe('[::1]');
    });

    it('sets browser hardening and no-store headers on real responses', async () => {
        const { server } = recorderHttp();
        servers.push(server);
        const port = await listen(server);

        const response = await fetch(`http://127.0.0.1:${port}/_recorder/api/history`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('never exposes an Appium session id through history, details, or SSE', async () => {
        const upstream = createHttpServer((_request, response) => {
            response.setHeader('content-type', 'application/json');
            response.end('{"value":null}');
        });
        servers.push(upstream);
        const upstreamPort = await listen(upstream);
        const { server } = recorderHttp({ appiumUrl: `http://127.0.0.1:${upstreamPort}` });
        servers.push(server);
        const port = await listen(server);
        const sessionId = 'opaque-session-secret-7ca20d';
        const base = `http://127.0.0.1:${port}`;

        const action = await fetch(`${base}/session/${sessionId}/probe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        expect(action.status).toBe(200);
        await action.arrayBuffer();

        const history = await fetch(`${base}/_recorder/api/history`).then(response => response.json());
        const details = await fetch(`${base}/_recorder/api/interaction/1`).then(response => response.json());
        const streamResponse = await fetch(`${base}/_recorder/api/stream`);
        const initialStreamEvent = await readFirstSseEvent(streamResponse);

        expect(history).toMatchObject([{ path: '/probe' }]);
        expect(details).toMatchObject({ path: '/probe' });
        for (const payload of [history, details, initialStreamEvent]) {
            expect(JSON.stringify(payload)).not.toContain(sessionId);
        }
    });

    it('rejects unsupported chunked bodies and declared or streamed bodies above 10 MiB', async () => {
        const { server } = recorderHttp();
        servers.push(server);
        const port = await listen(server);
        const statusFor = (
            headers: Record<string, string>,
            writeBody: (outgoing: ReturnType<typeof request>) => void,
        ) => new Promise<number>((resolve, reject) => {
            const outgoing = request({
                host: '127.0.0.1',
                port,
                path: '/session/session-1/back',
                method: 'POST',
                headers,
            }, response => {
                response.resume();
                response.on('end', () => resolve(response.statusCode ?? 0));
            });
            outgoing.on('error', reject);
            writeBody(outgoing);
        });

        await expect(statusFor(
            { 'content-type': 'application/octet-stream' },
            outgoing => outgoing.end('chunked'),
        )).resolves.toBe(415);

        await expect(statusFor(
            { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024 + 1) },
            outgoing => outgoing.end(),
        )).resolves.toBe(413);

        await expect(statusFor(
            { 'content-type': 'application/json' },
            outgoing => {
                outgoing.write('{"data":"');
                for (let index = 0; index < 161; index++) outgoing.write('x'.repeat(64 * 1024));
                outgoing.end('"}');
            },
        )).resolves.toBe(413);
    });

    it('bounds a stalled upstream proxy request with an observable gateway error', async () => {
        const upstream = createHttpServer(() => undefined);
        servers.push(upstream);
        const upstreamPort = await listen(upstream);
        const app = express();
        app.use(createAppiumProxy(`http://127.0.0.1:${upstreamPort}`, 50));
        const proxy = createHttpServer(app);
        servers.push(proxy);
        const proxyPort = await listen(proxy);

        const started = Date.now();
        const response = await fetch(`http://127.0.0.1:${proxyPort}/status`);
        expect(response.status).toBe(504);
        await expect(response.json()).resolves.toEqual({ error: 'Appium proxy request failed' });
        expect(Date.now() - started).toBeLessThan(1_500);
    });

    it('terminates a partial upstream response instead of appending an error body', async () => {
        const upstream = createHttpServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/plain' });
            response.flushHeaders();
            response.write('partial-secret');
            const socket = response.socket;
            setTimeout(() => socket?.destroy(), 25);
        });
        servers.push(upstream);
        const upstreamPort = await listen(upstream);
        const app = express();
        app.use(createAppiumProxy(`http://127.0.0.1:${upstreamPort}`));
        const proxy = createHttpServer(app);
        servers.push(proxy);
        const proxyPort = await listen(proxy);

        await expect(fetch(`http://127.0.0.1:${proxyPort}/status`).then(response => response.text()))
            .rejects.toThrow();
    });

    it('proxies permitted WebSocket upgrades and blocks a foreign Origin before upstream', async () => {
        let upgrades = 0;
        const upstream = createHttpServer();
        upstream.on('upgrade', (_request, socket) => {
            upgrades++;
            socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        });
        servers.push(upstream);
        const upstreamPort = await listen(upstream);

        const { server } = recorderHttp({ appiumUrl: `http://127.0.0.1:${upstreamPort}` });
        servers.push(server);
        const port = await listen(server);

        await expect(rawUpgrade(port, 'http://localhost:3000')).resolves.toMatch(/^HTTP\/1\.1 101/);
        expect(upgrades).toBe(1);
        await expect(rawUpgrade(port, 'https://attacker.example')).resolves.toMatch(/^HTTP\/1\.1 403/);
        expect(upgrades).toBe(1);
    });

    it('proxies a find-and-click flow, waits for capture, and reuses the selector', async () => {
        const sourceGate = Promise.withResolvers<void>();
        const sourceRequested = Promise.withResolvers<void>();
        const upstreamRequests: string[] = [];
        let blockFirstSource = true;
        const screenshot = Buffer.from('png-bytes').toString('base64');

        const upstream = createHttpServer(async (req, res) => {
            const requestPath = req.url ?? '';
            upstreamRequests.push(`${req.method} ${requestPath}`);

            if (requestPath.endsWith('/source')) {
                if (blockFirstSource) {
                    blockFirstSource = false;
                    sourceRequested.resolve();
                    await sourceGate.promise;
                }
                res.end(JSON.stringify({ value: '<hierarchy />' }));
                return;
            }
            if (requestPath.endsWith('/screenshot')) {
                res.end(JSON.stringify({ value: screenshot }));
                return;
            }
            if (requestPath.endsWith('/element')) {
                res.end(JSON.stringify({
                    value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-1' },
                }));
                return;
            }
            res.end(JSON.stringify({ value: null }));
        });
        servers.push(upstream);
        const upstreamPort = await listen(upstream);

        const { server: recorderServer, recorder } = recorderHttp({
            appiumUrl: `http://127.0.0.1:${upstreamPort}`,
        });
        servers.push(recorderServer);
        const recorderPort = await listen(recorderServer);
        const sessionUrl = `http://127.0.0.1:${recorderPort}/session/session-1`;

        const findResponse = await fetch(`${sessionUrl}/element`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ using: 'accessibility id', value: 'Login' }),
        });
        expect(findResponse.status).toBe(200);
        await sourceRequested.promise;

        const clickCaptured = new Promise<void>(resolve => {
            const unsubscribe = recorder.on(event => {
                if (
                    event.type === 'interaction'
                    && event.data.path.endsWith('/element/element-1/click')
                    && event.data.source
                ) {
                    unsubscribe();
                    resolve();
                }
            });
        });
        const clickResponse = fetch(`${sessionUrl}/element/element-1/click`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });

        await new Promise<void>(resolve => setImmediate(resolve));
        expect(upstreamRequests).not.toContain('POST /session/session-1/element/element-1/click');

        sourceGate.resolve();
        expect((await clickResponse).status).toBe(200);
        await clickCaptured;

        const click = recorder.getHistory().find(interaction => interaction.actionKind === 'tap');
        expect(click).toMatchObject({
            elementInfo: { using: 'accessibility id', value: 'Login' },
            source: '<hierarchy />',
        });
        expect(click?.screenshotUrl).toMatch(/^\/_recorder\/api\/screenshot\/\d+\?v=\d+$/);

        const screenshotResponse = await fetch(`http://127.0.0.1:${recorderPort}${click?.screenshotUrl}`);
        expect(Buffer.from(await screenshotResponse.arrayBuffer())).toEqual(Buffer.from('png-bytes'));

        const trailingCaptured = new Promise<void>(resolve => {
            const unsubscribe = recorder.on(event => {
                if (event.type === 'interaction' && event.data.path.endsWith('/click/') && event.data.source) {
                    unsubscribe();
                    resolve();
                }
            });
        });
        const trailingResponse = await fetch(`${sessionUrl}/element/element-1/click/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        expect(trailingResponse.status).toBe(200);
        await trailingCaptured;
        expect(recorder.getHistory().at(-1)).toMatchObject({
            actionKind: 'tap',
            elementInfo: { using: 'accessibility id', value: 'Login' },
        });
    });

    it('holds the real per-session gate until a disconnected action settles upstream', async () => {
        const clickSeen = Promise.withResolvers<void>();
        const releaseClick = Promise.withResolvers<void>();
        let screenshotRequests = 0;
        const upstream = createHttpServer(async (req, res) => {
            if (req.url?.endsWith('/click')) {
                clickSeen.resolve();
                await releaseClick.promise;
                res.end(JSON.stringify({ value: null }));
                return;
            }
            if (req.url?.endsWith('/screenshot')) screenshotRequests++;
            res.end(JSON.stringify({ value: Buffer.from('png').toString('base64') }));
        });
        servers.push(upstream);
        const upstreamPort = await listen(upstream);
        const { server } = recorderHttp({ appiumUrl: `http://127.0.0.1:${upstreamPort}` });
        servers.push(server);
        const port = await listen(server);

        const abandoned = request({
            host: '127.0.0.1', port, method: 'POST',
            path: '/session/session-1/element/button/click',
            headers: { 'content-type': 'application/json' },
        });
        abandoned.on('error', () => undefined);
        abandoned.end('{}');
        await clickSeen.promise;
        abandoned.destroy();

        const next = fetch(`http://127.0.0.1:${port}/session/session-1/screenshot`);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(screenshotRequests).toBe(0);

        releaseClick.resolve();
        expect((await next).status).toBe(200);
        expect(screenshotRequests).toBe(1);
    });

    it('releases a disconnected action after a partial upstream response closes', async () => {
        const partialSeen = Promise.withResolvers<void>();
        const upstream = createHttpServer((req, res) => {
            if (req.url?.endsWith('/click')) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.write('{"value":');
                partialSeen.resolve();
                return;
            }
            res.end(JSON.stringify({ value: null }));
        });
        servers.push(upstream);
        const upstreamPort = await listen(upstream);
        const { server } = recorderHttp({ appiumUrl: `http://127.0.0.1:${upstreamPort}` });
        servers.push(server);
        const port = await listen(server);

        const disconnected = Promise.withResolvers<void>();
        const abandoned = request({
            host: '127.0.0.1', port, method: 'POST',
            path: '/session/session-1/element/button/click',
            headers: { 'content-type': 'application/json' },
        }, response => {
            response.once('data', () => {
                response.destroy();
                abandoned.destroy();
                disconnected.resolve();
            });
        });
        abandoned.on('error', () => undefined);
        abandoned.end('{}');
        await partialSeen.promise;
        await disconnected.promise;

        await expect(fetch(`http://127.0.0.1:${port}/session/session-1/screenshot`)
            .then(response => response.status)).resolves.toBe(200);
    });

    it('serves and then invalidates screenshot and detail resources after history is cleared', async () => {
        const { server, recorder } = recorderHttp();
        servers.push(server);
        const port = await listen(server);
        const interaction = recorder.recordInteraction({ method: 'POST', path: '/action' });
        recorder.attachCapturedState(interaction.id, {
            screenshot: Buffer.from('png-bytes').toString('base64'),
            source: '<screen />',
        });
        const base = `http://127.0.0.1:${port}`;

        const screenshot = await fetch(`${base}${interaction.screenshotUrl}`);
        expect(screenshot.headers.get('cache-control')).toBe('private, no-store');
        expect(Buffer.from(await screenshot.arrayBuffer())).toEqual(Buffer.from('png-bytes'));
        const details = await fetch(`${base}/_recorder/api/interaction/${interaction.id}`);
        expect(await details.json()).toMatchObject({ id: interaction.id, source: '<screen />' });

        expect((await fetch(`${base}/_recorder/api/history`, { method: 'DELETE' })).status).toBe(200);
        expect((await fetch(`${base}${interaction.screenshotUrl}`)).status).toBe(404);
        expect((await fetch(`${base}/_recorder/api/interaction/${interaction.id}`)).status).toBe(404);
    });

    it('caps real SSE clients and frees a slot when one disconnects', async () => {
        const { server } = recorderHttp();
        servers.push(server);
        const port = await listen(server);
        const url = `http://127.0.0.1:${port}/_recorder/api/stream`;
        const streams = await Promise.all(Array.from({ length: 32 }, () => fetch(url)));
        expect(streams.every(response => response.status === 200)).toBe(true);
        expect((await fetch(url)).status).toBe(429);

        await streams[0].body?.cancel();
        await vi.waitFor(async () => expect((await fetch(url)).status).toBe(200));
        await Promise.all(streams.slice(1).map(response => response.body?.cancel()));
    });

    it('disconnects a real slow SSE reader after its bounded queue fills', async () => {
        const { server, recorder } = recorderHttp();
        servers.push(server);
        const port = await listen(server);
        const responsePromise = new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
            const outgoing = request({ host: '127.0.0.1', port, path: '/_recorder/api/stream' }, response => {
                response.pause();
                resolve(response);
            });
            outgoing.on('error', reject);
            outgoing.end();
        });
        const response = await responsePromise;
        const closed = once(response, 'end');
        for (let index = 0; index < 500; index++) {
            recorder.recordInteraction({
                method: 'POST',
                path: `/${'\0'.repeat(1_024)}`,
                elementInfo: { using: '\0'.repeat(128), value: '\0'.repeat(1_024) },
            });
        }
        response.resume();

        await expect(Promise.race([
            closed,
            new Promise((_, reject) => setTimeout(() => reject(new Error('SSE stream stayed open')), 2_000)),
        ])).resolves.toBeDefined();
    });

    it('streams a bounded summary for large interactions and exposes complete details separately', async () => {
        const { server, recorder } = recorderHttp();
        servers.push(server);
        const interaction = recorder.recordInteraction({ method: 'POST', path: '/large' });
        recorder.attachCapturedState(interaction.id, {
            source: `<Root>${'x'.repeat(3 * 1024 * 1024)}</Root>`,
        });
        const port = await listen(server);
        const response = await fetch(`http://127.0.0.1:${port}/_recorder/api/stream`);
        const event = await readFirstSseEvent(response);
        if (!Array.isArray(event.data)) throw new TypeError('Expected an initial interaction array');
        const summary = recordOf(event.data[0]);

        expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(summary).toMatchObject({
            id: interaction.id,
            detailsTruncated: true,
            detailsUrl: `/_recorder/api/interaction/${interaction.id}`,
        });
        const details = await fetch(`http://127.0.0.1:${port}${String(summary.detailsUrl)}`);
        expect(recordOf(await details.json()).source).toHaveLength(
            3 * 1024 * 1024 + '<Root></Root>'.length,
        );
    });

    it('replays every retained id in one bounded compact snapshot after reconnect', async () => {
        const { server, recorder } = recorderHttp();
        servers.push(server);
        for (let index = 0; index < 500; index++) {
            recorder.recordInteraction({
                method: 'POST',
                path: `/${index}/${'p'.repeat(2_000)}`,
                elementInfo: { using: 'xpath', value: `//node[@id="${'v'.repeat(2_000)}"]` },
            });
        }
        const port = await listen(server);
        const event = await readFirstSseEvent(await fetch(
            `http://127.0.0.1:${port}/_recorder/api/stream`,
        ));
        if (!Array.isArray(event.data)) throw new TypeError('Expected an initial interaction array');
        const summaries = event.data.map(recordOf);

        expect(summaries.map(summary => summary.id)).toEqual(Array.from({ length: 500 }, (_, index) => index + 1));
        expect(summaries.every(summary => summary.detailsTruncated === true)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(2 * 1024 * 1024);
    });

    it('replays large retained history as compact events without overflowing the SSE queue', async () => {
        const { server, recorder } = recorderHttp();
        servers.push(server);
        for (let index = 0; index < 280; index++) {
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: `/${'\0'.repeat(1_024)}`,
                elementInfo: { using: '\0'.repeat(128), value: '\0'.repeat(1_024) },
            });
            recorder.attachCapturedState(interaction.id, {
                source: `<Root>${'x'.repeat(64 * 1024)}</Root>`,
            });
        }
        const port = await listen(server);
        const response = await fetch(`http://127.0.0.1:${port}/_recorder/api/stream`);
        await new Promise<void>(resolve => setImmediate(resolve));
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        const ids: number[] = [];
        let buffer = '';
        while (ids.length < 280) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error(`SSE replay ended after ${ids.length} interactions`);
            buffer += decoder.decode(chunk.value, { stream: true });
            while (buffer.includes('\n\n')) {
                const boundary = buffer.indexOf('\n\n');
                const event = recordOf(JSON.parse(buffer.slice(0, boundary).replace(/^data: /, '')));
                buffer = buffer.slice(boundary + 2);
                if (Array.isArray(event.data)) {
                    ids.push(...event.data.map(value => Number(recordOf(value).id)));
                } else if (event.type === 'interaction') {
                    ids.push(Number(recordOf(event.data).id));
                }
            }
        }
        await reader.cancel();

        expect(ids).toEqual(Array.from({ length: 280 }, (_, index) => index + 1));
    });

    it('rejects startup when the requested port is already occupied', async () => {
        const occupied = createHttpServer();
        servers.push(occupied);
        const port = await listen(occupied);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await expect(startServer({
            host: '127.0.0.1',
            port,
            appiumUrl: 'http://127.0.0.1:4723',
        })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    });
});
