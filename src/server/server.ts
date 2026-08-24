import express from 'express';
import { once } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { DEFAULT_RECORDER_OPTIONS, type RecorderOptions } from './types';
import { AppiumCommandClient } from '../core/appium/client';
import { InteractionRecorder } from './interaction-recorder';
import { createSessionMiddleware, createAppiumProxy } from './proxy-middleware';
import { createRoutes } from './routes';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_APPIUM_REQUEST_BYTES = 10 * 1024 * 1024;
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
].join('; ');

function isLoopbackBindHost(host: unknown): host is string {
    return typeof host === 'string' && LOOPBACK_HOSTS.has(host);
}

function isLoopbackHostname(host: unknown): host is string {
    return typeof host === 'string'
        && LOOPBACK_HOSTS.has(host.toLowerCase().replace(/^\[|\]$/g, ''));
}

function isLoopbackHostHeader(host: string | undefined): boolean {
    if (!host) return false;
    try {
        return isLoopbackHostname(new URL(`http://${host}`).hostname);
    } catch {
        /* malformed Host headers are forbidden */
        return false;
    }
}

function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    try {
        return isLoopbackHostname(new URL(origin).hostname);
    } catch {
        /* malformed Origin headers are forbidden */
        return false;
    }
}

function rejectUpgrade(socket: Socket): void {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

export function createServer(options: RecorderOptions = {}) {
    const appiumUrl = options.appiumUrl ?? DEFAULT_RECORDER_OPTIONS.appiumUrl;
    const host = options.host ?? DEFAULT_RECORDER_OPTIONS.host;
    if (!isLoopbackBindHost(host)) {
        throw new Error('Recorder host must be localhost, 127.0.0.1, or ::1');
    }

    const app = express();
    const appiumClient = new AppiumCommandClient(appiumUrl);
    const recorder = new InteractionRecorder();

    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
        res.setHeader('X-Content-Type-Options', 'nosniff');

        if (!isLoopbackHostname(req.hostname) || !isAllowedOrigin(req.get('origin'))) {
            res.status(403).json({ error: 'Recorder is local-only' });
            return;
        }
        next();
    });

    app.use('/session', (req, res, next) => {
        const contentLength = req.get('content-length');
        const declaredBytes = contentLength === undefined ? 0 : Number(contentLength);
        if (
            contentLength !== undefined
            && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_APPIUM_REQUEST_BYTES)
        ) {
            res.setHeader('Connection', 'close');
            res.status(413).json({ error: 'Appium request body exceeds 10 MiB' });
            return;
        }

        const hasBody = declaredBytes > 0 || req.get('transfer-encoding') !== undefined;
        if (hasBody && !req.is(['application/json', 'application/*+json'])) {
            res.setHeader('Connection', 'close');
            res.status(415).json({ error: 'Appium request bodies must be JSON' });
            return;
        }
        next();
    });

    app.use(express.json({ type: ['application/json', 'application/*+json'], limit: '10mb' }));
    app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
        const bodyError = error !== null && typeof error === 'object'
            ? Object.fromEntries(Object.entries(error))
            : {};
        if (bodyError.type === 'entity.too.large' || bodyError.status === 413) {
            req.resume();
            res.setHeader('Connection', 'close');
            res.status(413).json({ error: 'Appium request body exceeds 10 MiB' });
            return;
        }
        if (bodyError.type === 'entity.parse.failed' || bodyError.status === 400) {
            res.status(400).json({ error: 'Appium request body must be valid JSON' });
            return;
        }
        next(error);
    });

    app.use(createRoutes(recorder));

    app.use('/session/:sessionId', createSessionMiddleware(recorder, appiumClient));

    const appiumProxy = createAppiumProxy(appiumUrl);
    app.use(appiumProxy);

    const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        if (!isLoopbackHostHeader(req.headers.host) || !isAllowedOrigin(origin)) {
            rejectUpgrade(socket);
            return;
        }
        appiumProxy.upgrade(req, socket, head);
    };

    return { app, recorder, handleUpgrade };
}

export async function startServer(options: RecorderOptions = {}) {
    const host = options.host ?? DEFAULT_RECORDER_OPTIONS.host;
    const port = options.port ?? DEFAULT_RECORDER_OPTIONS.port;
    const { app, handleUpgrade } = createServer(options);

    const server = createHttpServer(app);
    server.on('upgrade', handleUpgrade);
    server.listen(port, host);
    await once(server, 'listening');
    return server;
}
