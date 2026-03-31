import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { InteractionRecorder } from './interaction-recorder';
import type { ActionKind, ReplayRequest, ReplayResult } from './types';
import { AppiumCommandClient, AppiumCommandError } from '../core/appium/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve UI dist path: works from both source (src/server/) and bundle (dist/)
function resolveUiDir(): string {
    const candidates = [
        path.join(__dirname, '../../dist/ui'),  // dev: running from src/server/
        path.join(__dirname, 'ui'),              // prod: running from dist/
    ];
    return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

const uiDir = resolveUiDir();

const REPLAYABLE_ACTIONS: ActionKind[] = ['tap', 'type', 'clear', 'back', 'swipe', 'scroll'];

export function createRoutes(recorder: InteractionRecorder, appiumCommandClient: AppiumCommandClient) {
    const router = Router();

    // Serve the UI
    router.get('/_recorder', (_req, res) => {
        res.sendFile(path.join(uiDir, 'index.html'));
    });

    // Serve static assets using express.static for better performance and caching
    router.use('/_recorder/assets', express.static(path.join(uiDir, 'assets')));

    // API: Get history
    router.get('/_recorder/api/history', (_req, res) => {
        res.json(recorder.getHistory());
    });

    // API: Clear history
    router.delete('/_recorder/api/history', (_req, res) => {
        recorder.clearHistory();
        res.json({ ok: true });
    });

    // API: Server-Sent Events for real-time updates
    router.get('/_recorder/api/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Send initial history
        res.write(`data: ${JSON.stringify({ type: 'init', data: recorder.getHistory() })}\n\n`);

        // Listen for new interactions
        const unsubscribe = recorder.on((event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });

        // Clean up on close
        req.on('close', () => {
            unsubscribe();
        });
    });

    // API: Replay an interaction
    router.post('/_recorder/api/interactions/:id/replay', async (req, res) => {
        const interactionId = parseInt(req.params.id, 10);
        const history = recorder.getHistory();
        const interaction = history.find(i => i.id === interactionId);

        if (!interaction) {
            res.status(404).json({ ok: false, error: 'Interaction not found' } as ReplayResult);
            return;
        }

        const actionKind = interaction.actionKind;
        if (!actionKind || !REPLAYABLE_ACTIONS.includes(actionKind)) {
            res.status(400).json({
                ok: false,
                interactionId,
                actionKind: actionKind || 'unknown',
                error: `Action kind "${actionKind || 'unknown'}" is not replayable. Supported: ${REPLAYABLE_ACTIONS.join(', ')}`,
            } as ReplayResult);
            return;
        }

        const sessionId = interaction.sessionId || (req.body as ReplayRequest)?.sessionId;
        if (!sessionId) {
            res.status(400).json({
                ok: false,
                interactionId,
                actionKind,
                error: 'No sessionId available for replay. This interaction was recorded without session metadata.',
            } as ReplayResult);
            return;
        }

        // Resolve selector: prefer request override, fall back to recorded elementInfo
        const selector = (req.body as ReplayRequest)?.selector || interaction.elementInfo;

        try {
            switch (actionKind) {
                case 'tap': {
                    if (!selector) {
                        res.status(400).json({
                            ok: false, interactionId, actionKind,
                            error: 'No selector available for tap replay',
                        } as ReplayResult);
                        return;
                    }
                    await appiumCommandClient.tap(sessionId, selector.using, selector.value);
                    break;
                }
                case 'type': {
                    if (!selector) {
                        res.status(400).json({
                            ok: false, interactionId, actionKind,
                            error: 'No selector available for type replay',
                        } as ReplayResult);
                        return;
                    }
                    const text = (req.body as ReplayRequest)?.text || interaction.body?.text || interaction.body?.value?.join('') || '';
                    await appiumCommandClient.type(sessionId, selector.using, selector.value, text, false);
                    break;
                }
                case 'clear': {
                    if (!selector) {
                        res.status(400).json({
                            ok: false, interactionId, actionKind,
                            error: 'No selector available for clear replay',
                        } as ReplayResult);
                        return;
                    }
                    await appiumCommandClient.clear(sessionId, selector.using, selector.value);
                    break;
                }
                case 'back': {
                    await appiumCommandClient.back(sessionId);
                    break;
                }
                case 'swipe': {
                    const body = req.body as ReplayRequest;
                    const from = body?.from || interaction.body?.actions?.[0]?.actions?.find((a: any) => a.type === 'pointerMove')
                        ? { x: interaction.body.actions[0].actions[0].x, y: interaction.body.actions[0].actions[0].y }
                        : null;
                    const to = body?.to || (() => {
                        const moves = interaction.body?.actions?.[0]?.actions?.filter((a: any) => a.type === 'pointerMove');
                        if (moves && moves.length > 1) {
                            return { x: moves[moves.length - 1].x, y: moves[moves.length - 1].y };
                        }
                        return null;
                    })();
                    if (!from || !to) {
                        res.status(400).json({
                            ok: false, interactionId, actionKind,
                            error: 'Cannot determine swipe coordinates from recorded data',
                        } as ReplayResult);
                        return;
                    }
                    const durationMs = body?.durationMs || 300;
                    await appiumCommandClient.swipe(sessionId, from, to, durationMs);
                    break;
                }
                case 'scroll': {
                    const direction = (req.body as ReplayRequest)?.direction || 'down';
                    const scrollDuration = (req.body as ReplayRequest)?.durationMs || 300;
                    await appiumCommandClient.scroll(sessionId, direction, scrollDuration);
                    break;
                }
            }

            res.json({ ok: true, interactionId, actionKind } as ReplayResult);
        } catch (err) {
            const message = err instanceof AppiumCommandError
                ? err.message
                : err instanceof Error ? err.message : 'Unknown replay error';
            res.status(500).json({
                ok: false,
                interactionId,
                actionKind,
                error: message,
            } as ReplayResult);
        }
    });

    return router;
}
