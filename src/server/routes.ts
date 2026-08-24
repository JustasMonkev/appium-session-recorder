import express, { Router } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { InteractionRecorder } from './interaction-recorder';
import type { Interaction, ServerEvent } from './types';

function resolveUiDir(): string {
    const sourceBuild = path.join(import.meta.dirname, '../../dist/ui');
    return existsSync(sourceBuild) ? sourceBuild : path.join(import.meta.dirname, 'ui');
}

const MAX_STREAMS = 32;
const MAX_STREAM_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_QUEUE_BYTES = 4 * 1024 * 1024;
const liveEventMessages = new WeakMap<ServerEvent, string>();

function interactionId(value: string | undefined): number | undefined {
    if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
    if (Buffer.byteLength(value) <= maxBytes) return value;
    let result = '';
    let bytes = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character);
        if (bytes + characterBytes > maxBytes) break;
        result += character;
        bytes += characterBytes;
    }
    return result;
}

function streamInteraction(interaction: Interaction, compact = false): string {
    if (!compact && (!interaction.source || Buffer.byteLength(interaction.source) <= MAX_STREAM_MESSAGE_BYTES / 2)) {
        const serialized = JSON.stringify(interaction);
        if (Buffer.byteLength(serialized) <= MAX_STREAM_MESSAGE_BYTES) return serialized;
    }
    const bounded: Interaction = {
        id: interaction.id,
        timestamp: truncateUtf8(interaction.timestamp, 128),
        method: truncateUtf8(interaction.method, 32),
        path: truncateUtf8(interaction.path, 1024),
        actionKind: interaction.actionKind,
        captureStatus: interaction.captureStatus,
        screenshotUrl: interaction.screenshotUrl,
        detailsUrl: `/_recorder/api/interaction/${interaction.id}`,
        detailsTruncated: true,
    };
    if (
        interaction.elementInfo
        && Buffer.byteLength(interaction.elementInfo.using) <= 128
        && Buffer.byteLength(interaction.elementInfo.value) <= 1024
    ) {
        bounded.elementInfo = interaction.elementInfo;
    }
    return JSON.stringify(bounded);
}

function streamEvent(event: ServerEvent, compact = false): string {
    if (!compact) {
        const cached = liveEventMessages.get(event);
        if (cached) return cached;
    }
    const data = event.type === 'interaction'
        ? streamInteraction(event.data, compact)
        : JSON.stringify(event.data);
    const message = `data: {"type":${JSON.stringify(event.type)},"data":${data}}\n\n`;
    if (!compact) liveEventMessages.set(event, message);
    return message;
}

function initialStreamBatch(history: Interaction[]): { message: string; nextIndex: number } {
    const interactions: string[] = [];
    const envelopeBytes = Buffer.byteLength('data: {"type":"init","data":[]}\n\n');
    let entriesBytes = 0;
    let nextIndex = 0;
    for (; nextIndex < history.length; nextIndex++) {
        const serialized = streamInteraction(history[nextIndex], true);
        const nextBytes = entriesBytes + Buffer.byteLength(serialized) + (interactions.length > 0 ? 1 : 0);
        if (envelopeBytes + nextBytes > MAX_STREAM_MESSAGE_BYTES) break;
        interactions.push(serialized);
        entriesBytes = nextBytes;
    }
    return {
        message: `data: {"type":"init","data":[${interactions.join(',')}]}\n\n`,
        nextIndex,
    };
}

export function createRoutes(recorder: InteractionRecorder, uiDir = resolveUiDir()) {
    const router = Router();
    let activeStreams = 0;

    router.get('/_recorder', (_req, res) => {
        res.sendFile(path.join(uiDir, 'index.html'));
    });

    router.use('/_recorder/assets', express.static(path.join(uiDir, 'assets')));

    router.get('/_recorder/api/history', (_req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(recorder.getHistory());
    });

    router.get('/_recorder/api/interaction/:id', (req, res) => {
        const id = interactionId(req.params.id);
        const interaction = id === undefined ? undefined : recorder.getInteraction(id);
        res.setHeader('Cache-Control', 'private, no-store');
        if (!interaction) {
            res.status(404).json({ error: 'Interaction not found' });
            return;
        }
        res.json(interaction);
    });

    router.get('/_recorder/api/screenshot/:id', (req, res) => {
        const id = interactionId(req.params.id);
        const screenshot = id === undefined ? undefined : recorder.getScreenshot(id);
        if (!screenshot) {
            res.status(404).json({ error: 'Screenshot not found' });
            return;
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, no-store');
        res.end(screenshot);
    });

    router.delete('/_recorder/api/history', (_req, res) => {
        recorder.clearHistory();
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ ok: true });
    });

    router.get('/_recorder/api/stream', (req, res) => {
        if (activeStreams >= MAX_STREAMS) {
            res.status(429).json({ error: 'Too many event streams' });
            return;
        }
        activeStreams++;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Connection', 'keep-alive');

        let unsubscribe = () => {};
        let closed = false;
        let waitingForDrain = false;
        let queuedBytes = 0;
        const queue: string[] = [];
        const close = () => {
            if (closed) return;
            closed = true;
            activeStreams--;
            unsubscribe();
        };
        const send = (message: string) => {
            if (closed) return;
            if (waitingForDrain) {
                const bytes = Buffer.byteLength(message);
                if (queuedBytes + bytes > MAX_STREAM_QUEUE_BYTES) {
                    close();
                    res.end();
                    return;
                }
                queue.push(message);
                queuedBytes += bytes;
                return;
            }
            waitingForDrain = !res.write(message);
        };
        const drain = () => {
            waitingForDrain = false;
            while (!closed && queue.length > 0) {
                const message = queue.shift();
                if (!message) break;
                queuedBytes -= Buffer.byteLength(message);
                if (!res.write(message)) {
                    waitingForDrain = true;
                    break;
                }
            }
        };
        req.on('close', close);
        res.on('close', close);
        res.on('error', close);
        res.on('drain', drain);

        const history = recorder.getHistory();
        const initial = initialStreamBatch(history);
        send(initial.message);
        for (let index = initial.nextIndex; index < history.length; index++) {
            send(streamEvent({ type: 'interaction', data: history[index] }, true));
        }

        unsubscribe = recorder.on((event) => {
            send(streamEvent(event));
        });
        if (closed) unsubscribe();
    });

    return router;
}
