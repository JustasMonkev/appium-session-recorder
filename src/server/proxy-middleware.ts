import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import type { Interaction } from './types';
import { AppiumClient } from './appium-client';
import { InteractionRecorder } from './interaction-recorder';

export function createSessionMiddleware(
    recorder: InteractionRecorder,
    appiumClient: AppiumClient,
) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const { sessionId } = req.params;

        // Skip ignored endpoints
        if (!recorder.shouldRecord(req.method, req.originalUrl)) {
            return next();
        }

        const isAction = recorder.isActionEndpoint(req.method, req.path);

        // Create interaction record
        const interactionData: Omit<Interaction, 'id' | 'timestamp'> = {
            method: req.method,
            path: req.originalUrl,
            body: req.body && Object.keys(req.body).length > 0 ? req.body : undefined,
        };

        // Extract element info for find operations
        if (req.body?.using && req.body?.value) {
            interactionData.elementInfo = {
                using: req.body.using,
                value: req.body.value,
            };
        }

        const interaction = recorder.recordInteraction(interactionData);

        console.log(`[${interaction.id}] ${req.method} ${req.originalUrl}`);
        if (interaction.body) {
            console.log('Body:', JSON.stringify(interaction.body, null, 2));
        }

        // For actions, capture state after the action completes
        if (isAction) {
            res.on('finish', async () => {
                const state = await appiumClient.captureState(sessionId);
                recorder.updateInteraction(interaction.id, {
                    screenshot: state.screenshot,
                    source: state.source,
                });
                console.log(`[${interaction.id}] State captured (screenshot + source)`);
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
