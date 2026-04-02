import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import type { ActionKind, Interaction } from './types';
import { AppiumClient } from './appium-client';
import { InteractionRecorder } from './interaction-recorder';

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

function classifyAction(method: string, path: string): ActionKind {
    if (/\/element\/[^/]+\/click$/.test(path)) return 'tap';
    if (/\/element\/[^/]+\/value$/.test(path)) return 'type';
    if (/\/element\/[^/]+\/clear$/.test(path)) return 'clear';
    if (/\/back$/.test(path)) return 'back';
    if (/\/touch\/perform$/.test(path)) return 'swipe';
    if (/\/actions$/.test(path) && method === 'POST') return 'swipe';
    if (/\/element$/.test(path) || /\/elements$/.test(path)) return 'find';
    return 'unknown';
}

function extractSelector(body: Request['body']): Interaction['elementInfo'] | undefined {
    if (body?.using && body?.value) {
        return {
            using: body.using,
            value: body.value,
        };
    }

    return undefined;
}

function extractElementIdFromActionPath(path: string): string | undefined {
    return path.match(/\/element\/([^/]+)\/(?:click|value|clear)$/)?.[1];
}

function isFindRequest(path: string): boolean {
    return /\/element$/.test(path) || /\/elements$/.test(path);
}

function extractElementIdsFromResponseBody(body: string): string[] {
    if (!body) return [];

    try {
        const parsed = JSON.parse(body);
        const value = parsed?.value;
        const values = Array.isArray(value) ? value : [value];

        return values
            .map((entry) => {
                if (!entry || typeof entry !== 'object') return null;
                const candidate = entry as Record<string, unknown>;
                return candidate[W3C_ELEMENT_KEY] || candidate.ELEMENT;
            })
            .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    } catch {
        return [];
    }
}

export function createSessionMiddleware(
    recorder: InteractionRecorder,
    appiumClient: AppiumClient,
) {
    const selectorsByElementId = new Map<string, NonNullable<Interaction['elementInfo']>>();

    return async (req: Request, res: Response, next: NextFunction) => {
        const { sessionId } = req.params;

        // Skip ignored endpoints
        if (!recorder.shouldRecord(req.method, req.originalUrl)) {
            return next();
        }

        const isAction = recorder.isActionEndpoint(req.method, req.path);
        const actionKind = classifyAction(req.method, req.path);
        const requestSelector = extractSelector(req.body);
        const actionElementId = extractElementIdFromActionPath(req.path);
        const mappedSelector = actionElementId
            ? selectorsByElementId.get(`${sessionId}:${actionElementId}`)
            : undefined;

        // Create interaction record
        const interactionData: Omit<Interaction, 'id' | 'timestamp'> = {
            method: req.method,
            path: req.originalUrl,
            body: req.body && Object.keys(req.body).length > 0 ? req.body : undefined,
            sessionId,
            actionKind,
        };

        if (requestSelector || mappedSelector) {
            interactionData.elementInfo = requestSelector || mappedSelector;
        }

        const shouldCaptureSelectorMapping = !!requestSelector && isFindRequest(req.path);
        const responseChunks: Buffer[] = [];

        if (shouldCaptureSelectorMapping) {
            const originalWrite = res.write.bind(res);
            const originalEnd = res.end.bind(res);

            res.write = ((chunk: any, ...args: any[]) => {
                if (chunk) {
                    responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }

                return originalWrite(chunk, ...args);
            }) as Response['write'];

            res.end = ((chunk: any, ...args: any[]) => {
                if (chunk) {
                    responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }

                return originalEnd(chunk, ...args);
            }) as Response['end'];
        }

        const interaction = recorder.recordInteraction(interactionData);

        console.log(`[${interaction.id}] ${req.method} ${req.originalUrl} (${actionKind})`);
        if (interaction.body) {
            console.log('Body:', JSON.stringify(interaction.body, null, 2));
        }

        // For actions, capture state after the action completes
        if (isAction || shouldCaptureSelectorMapping) {
            res.on('finish', async () => {
                if (shouldCaptureSelectorMapping && requestSelector) {
                    const body = Buffer.concat(responseChunks).toString('utf8');
                    const elementIds = extractElementIdsFromResponseBody(body);
                    elementIds.forEach((elementId) => {
                        selectorsByElementId.set(`${sessionId}:${elementId}`, requestSelector);
                    });
                }

                if (!isAction) return;

                try {
                    const state = await appiumClient.captureState(sessionId);
                    recorder.updateInteraction(interaction.id, {
                        screenshot: state.screenshot,
                        source: state.source,
                    });
                    console.log(`[${interaction.id}] State captured (screenshot + source)`);
                } catch (error) {
                    console.error(`[${interaction.id}] Failed to capture state`, error);
                }
            });
        }

        next();
    };
}

export function createAppiumProxy(appiumUrl: string) {
    return createProxyMiddleware({
        target: appiumUrl,
        changeOrigin: true,
        ws: true,
        on: {
            proxyReq: fixRequestBody,
        },
    });
}
