import type { NextFunction, Request, Response } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import type { AppiumCommandClient } from '../core/appium/client';
import type { CapturedState, Interaction } from './types';
import { classifyAction, InteractionRecorder } from './interaction-recorder';

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const MAX_SELECTOR_MAPPINGS = 5_000;
const MAX_SELECTOR_RESPONSE_BYTES = 1024 * 1024;
const MAX_SELECTOR_FIELD_BYTES = 64 * 1024;
const MAX_SELECTOR_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_CAPTURES = 2;
const MAX_QUEUED_CAPTURES = 16;
const PROXY_SETTLED_EVENT = 'appium-recorder:proxy-settled';

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    // SAFETY: the runtime guard above narrows value to a non-array object with string-key access.
    return value as Record<string, unknown>;
}

function extractSelector(body: unknown): Interaction['elementInfo'] | undefined {
    const candidate = asRecord(body);
    const selector = typeof candidate?.using === 'string'
        && candidate.using.length > 0
        && typeof candidate.value === 'string'
        && candidate.value.length > 0
        ? { using: candidate.using, value: candidate.value }
        : undefined;
    if (!selector) return undefined;
    return Buffer.byteLength(selector.using) <= MAX_SELECTOR_FIELD_BYTES
        && Buffer.byteLength(selector.value) <= MAX_SELECTOR_FIELD_BYTES
        ? selector
        : undefined;
}

function extractElementIdFromActionPath(path: string): string | undefined {
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const encoded = path.match(/\/element\/([^/]+)\/(?:click|value|clear)$/)?.[1];
    if (!encoded) return undefined;
    try {
        return decodeURIComponent(encoded);
    } catch {
        /* invalid encoded element IDs cannot have a selector mapping */
        return undefined;
    }
}

function isFindRequest(path: string): boolean {
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return /\/elements?$/.test(path);
}

type ElementIdExtraction =
    | { ok: true; ids: string[] }
    | { ok: false };

function extractElementIdsFromResponseBody(body: string): ElementIdExtraction {
    try {
        const parsed = asRecord(JSON.parse(body));
        const values = Array.isArray(parsed?.value) ? parsed.value : [parsed?.value];
        const ids = values.flatMap(value => {
            const element = asRecord(value);
            const id = element?.[W3C_ELEMENT_KEY] ?? element?.ELEMENT;
            return typeof id === 'string' && id.length > 0 ? [id] : [];
        });
        return { ok: true, ids };
    } catch {
        return { ok: false };
    }
}

function bufferChunk(chunk: unknown): Buffer | undefined {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) return Buffer.from(chunk);
    return undefined;
}

export function createSessionMiddleware(
    recorder: InteractionRecorder,
    appiumClient: Pick<AppiumCommandClient, 'captureState'>,
) {
    type Selector = NonNullable<Interaction['elementInfo']>;
    type SelectorEntry = {
        sessionId: string;
        elementId: string;
        selector: Selector;
        bytes: number;
    };
    type CaptureJob = {
        run: () => Promise<CapturedState>;
        resolve: (state: CapturedState | undefined) => void;
        reject: (error: unknown) => void;
    };

    const selectorsBySession = new Map<string, Map<string, SelectorEntry>>();
    const selectorLru = new Map<SelectorEntry, true>();
    const capturesBySession = new Map<string, Promise<void>>();
    const captureQueue: CaptureJob[] = [];
    let selectorCacheBytes = 0;
    let activeCaptures = 0;

    const removeSelector = (entry: SelectorEntry) => {
        const session = selectorsBySession.get(entry.sessionId);
        if (session?.get(entry.elementId) === entry) session.delete(entry.elementId);
        if (session?.size === 0) selectorsBySession.delete(entry.sessionId);
        if (selectorLru.delete(entry)) selectorCacheBytes -= entry.bytes;
    };
    const clearSessionSelectors = (sessionId: string) => {
        const session = selectorsBySession.get(sessionId);
        if (!session) return;
        for (const entry of session.values()) removeSelector(entry);
    };
    const storeSelector = (sessionId: string, elementId: string, selector: Selector) => {
        const fields = [sessionId, elementId, selector.using, selector.value];
        if (fields.some(field => Buffer.byteLength(field) > MAX_SELECTOR_FIELD_BYTES)) return;

        const existing = selectorsBySession.get(sessionId)?.get(elementId);
        if (existing) removeSelector(existing);

        const entry: SelectorEntry = {
            sessionId,
            elementId,
            selector,
            bytes: fields.reduce((total, field) => total + Buffer.byteLength(field), 0),
        };
        const session = selectorsBySession.get(sessionId) ?? new Map<string, SelectorEntry>();
        selectorsBySession.set(sessionId, session);
        session.set(elementId, entry);
        selectorLru.set(entry, true);
        selectorCacheBytes += entry.bytes;

        while (selectorLru.size > MAX_SELECTOR_MAPPINGS || selectorCacheBytes > MAX_SELECTOR_CACHE_BYTES) {
            const oldest = selectorLru.keys().next().value;
            if (!oldest) break;
            removeSelector(oldest);
        }
    };
    const getSelector = (sessionId: string, elementId: string) => {
        const entry = selectorsBySession.get(sessionId)?.get(elementId);
        if (!entry) return undefined;
        selectorLru.delete(entry);
        selectorLru.set(entry, true);
        return entry.selector;
    };

    const startCapture = (job: CaptureJob) => {
        activeCaptures++;
        void job.run()
            .then(job.resolve, job.reject)
            .finally(() => {
                activeCaptures--;
                const next = captureQueue.shift();
                if (next) startCapture(next);
            });
    };
    const scheduleCapture = (run: () => Promise<CapturedState>): Promise<CapturedState | undefined> => {
        if (activeCaptures >= MAX_CONCURRENT_CAPTURES && captureQueue.length >= MAX_QUEUED_CAPTURES) {
            return Promise.resolve(undefined);
        }
        return new Promise((resolve, reject) => {
            const job = { run, resolve, reject };
            if (activeCaptures < MAX_CONCURRENT_CAPTURES) startCapture(job);
            else captureQueue.push(job);
        });
    };

    recorder.on(event => {
        if (event.type !== 'clear') return;
        selectorsBySession.clear();
        selectorLru.clear();
        selectorCacheBytes = 0;
    });

    return async (req: Request, res: Response, next: NextFunction) => {
        const sessionId = req.params.sessionId;
        if (typeof sessionId !== 'string') {
            res.status(400).json({ error: 'Invalid session ID' });
            return;
        }

        const shouldRecord = req.method === 'POST';
        const actionKind = classifyAction(req.method, req.path);
        const isAction = shouldRecord && actionKind !== 'unknown';
        const pendingCapture = capturesBySession.get(sessionId);
        const captureGate = isAction ? Promise.withResolvers<void>() : undefined;
        const captureTail = captureGate
            ? pendingCapture?.then(() => captureGate.promise) ?? captureGate.promise
            : undefined;
        if (captureTail) capturesBySession.set(sessionId, captureTail);

        let gateReleased = false;
        const releaseCaptureGate = () => {
            if (!captureGate || gateReleased) return;
            gateReleased = true;
            captureGate.resolve();
            if (capturesBySession.get(sessionId) === captureTail) capturesBySession.delete(sessionId);
        };
        let responseSettled = false;
        let proxySettled = false;
        let recordedInteractionId: number | undefined;
        if (captureGate) {
            res.on(PROXY_SETTLED_EVENT, () => {
                proxySettled = true;
                if (responseSettled) releaseCaptureGate();
            });
            res.on('close', () => {
                if (responseSettled) return;
                responseSettled = true;
                if (recordedInteractionId !== undefined) {
                    recorder.markCaptureUnavailable(recordedInteractionId, 'failed');
                }
                if (proxySettled) releaseCaptureGate();
            });
        }

        try {
            if (pendingCapture) await pendingCapture;
            if (responseSettled || res.destroyed) {
                releaseCaptureGate();
                return;
            }

            if (req.method === 'DELETE' && req.path === '/') {
                clearSessionSelectors(sessionId);
            }

            if (!shouldRecord) {
                next();
                return;
            }

            const requestSelector = extractSelector(req.body);
            const actionElementId = extractElementIdFromActionPath(req.path);
            const mappedSelector = actionElementId ? getSelector(sessionId, actionElementId) : undefined;
            const interactionData: Omit<Interaction, 'id' | 'timestamp'> = {
                method: req.method,
                path: req.path,
                actionKind,
                elementInfo: requestSelector ?? mappedSelector,
                captureStatus: isAction ? 'pending' : undefined,
            };
            const shouldMapSelector = requestSelector !== undefined && isFindRequest(req.path);
            const responseChunks: Buffer[] = [];
            let responseBytes = 0;
            let responseTooLarge = false;

            if (shouldMapSelector) {
                const captureChunk = (chunk: unknown) => {
                    if (responseTooLarge) return;
                    const buffer = bufferChunk(chunk);
                    if (!buffer) return;
                    responseBytes += buffer.length;
                    if (responseBytes > MAX_SELECTOR_RESPONSE_BYTES) {
                        responseTooLarge = true;
                        responseChunks.length = 0;
                        return;
                    }
                    responseChunks.push(buffer);
                };
                const originalWrite = res.write.bind(res);
                const originalEnd = res.end.bind(res);

                const wrappedWrite = (...args: Parameters<Response['write']>) => {
                    captureChunk(args[0]);
                    return originalWrite(...args);
                };
                const wrappedEnd = (...args: Parameters<Response['end']>) => {
                    captureChunk(args[0]);
                    return originalEnd(...args);
                };
                // SAFETY: each wrapper forwards the exact overloaded tuple to its bound response method.
                res.write = wrappedWrite as Response['write'];
                // SAFETY: each wrapper forwards the exact overloaded tuple to its bound response method.
                res.end = wrappedEnd as Response['end'];
            }

            const interaction = recorder.recordInteraction(interactionData);
            recordedInteractionId = interaction.id;

            if (isAction || shouldMapSelector) {
                if (!captureGate) {
                    res.on('close', () => {
                        responseSettled = true;
                    });
                }
                res.on('finish', () => {
                    if (responseSettled) return;
                    responseSettled = true;
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        if (isAction) recorder.markCaptureUnavailable(interaction.id, 'skipped');
                        releaseCaptureGate();
                        return;
                    }

                    if (shouldMapSelector && requestSelector && !responseTooLarge) {
                        const body = Buffer.concat(responseChunks, responseBytes).toString('utf8');
                        const extraction = extractElementIdsFromResponseBody(body);
                        if (extraction.ok) {
                            for (const elementId of extraction.ids) {
                                storeSelector(sessionId, elementId, requestSelector);
                            }
                        }
                    }

                    if (!isAction) return;

                    void scheduleCapture(() => appiumClient.captureState(sessionId))
                        .then(state => {
                            if (state) recorder.attachCapturedState(interaction.id, state);
                            else {
                                recorder.markCaptureUnavailable(interaction.id, 'skipped');
                                console.error(`[${interaction.id}] State capture skipped: queue full`);
                            }
                        })
                        .catch(() => {
                            recorder.markCaptureUnavailable(interaction.id, 'failed');
                            console.error(`[${interaction.id}] Failed to capture state`);
                        })
                        .finally(releaseCaptureGate);
                });
            }

            next();
        } catch (error) {
            releaseCaptureGate();
            throw error;
        }
    };
}

export function createAppiumProxy(appiumUrl: string, timeoutMs = 120_000) {
    return createProxyMiddleware({
        target: appiumUrl,
        changeOrigin: true,
        ws: false,
        proxyTimeout: timeoutMs,
        on: {
            proxyReq: fixRequestBody,
            proxyRes: (proxyResponse, _request, response) => {
                let settled = false;
                const settle = () => {
                    if (settled) return;
                    settled = true;
                    response.emit(PROXY_SETTLED_EVENT);
                };
                proxyResponse.once('end', settle);
                proxyResponse.once('close', settle);
            },
            end: (_request, response) => {
                response.emit(PROXY_SETTLED_EVENT);
            },
            error: (error, _request, response) => {
                response.emit(PROXY_SETTLED_EVENT);
                if (!('writeHead' in response)) {
                    response.destroy();
                    return;
                }
                if (response.writableEnded || response.destroyed) return;
                if (response.headersSent) {
                    response.destroy();
                    return;
                }
                const code = error instanceof Error && 'code' in error ? error.code : undefined;
                const status = code === 'ECONNRESET' || code === 'ETIMEDOUT' ? 504 : 502;
                response.writeHead(status, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'Appium proxy request failed' }));
            },
        },
    });
}
