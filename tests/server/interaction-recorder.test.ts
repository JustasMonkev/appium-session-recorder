import { describe, it, expect, beforeEach, vi } from 'vitest';
import { classifyAction, InteractionRecorder } from '../../src/server/interaction-recorder';
import type { ServerEvent } from '../../src/server/types';

describe('InteractionRecorder', () => {
    let recorder: InteractionRecorder;

    beforeEach(() => {
        recorder = new InteractionRecorder();
    });

    describe('recording method boundary', () => {
        it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('does not classify %s requests as actions', method => {
            expect(classifyAction(method, '/session/123/element/abc123/click')).toBe('unknown');
        });

        it('classifies a POST action', () => {
            expect(classifyAction('POST', '/session/123/element/abc123/click')).toBe('tap');
        });
    });

    describe('classifyAction', () => {
        describe('POST method', () => {
            it('should identify click endpoint', () => {
                expect(classifyAction('POST', '/session/123/element/abc123/click')).toBe('tap');
            });

            it('should identify value endpoint', () => {
                expect(classifyAction('POST', '/session/123/element/abc123/value')).toBe('type');
            });

            it('should identify clear endpoint', () => {
                expect(classifyAction('POST', '/session/123/element/abc123/clear')).toBe('clear');
            });

            it('should identify element endpoint', () => {
                expect(classifyAction('POST', '/session/123/element')).toBe('find');
            });

            it('should identify elements endpoint', () => {
                expect(classifyAction('POST', '/session/123/elements')).toBe('find');
            });

            it('should identify touch/perform endpoint', () => {
                expect(classifyAction('POST', '/session/123/touch/perform')).toBe('swipe');
            });

            it('should identify actions endpoint', () => {
                expect(classifyAction('POST', '/session/123/actions')).toBe('swipe');
            });

            it('should identify back endpoint', () => {
                expect(classifyAction('POST', '/session/123/back')).toBe('back');
            });

            it('should identify forward endpoint', () => {
                expect(classifyAction('POST', '/session/123/forward')).toBe('forward');
            });

            it('should identify refresh endpoint', () => {
                expect(classifyAction('POST', '/session/123/refresh')).toBe('refresh');
            });
        });

        describe('DELETE method', () => {
            it('should not classify unrecorded DELETE requests as actions', () => {
                expect(classifyAction('DELETE', '/session/123/element/abc123/click')).toBe('unknown');
            });
        });

        describe('non-action endpoints', () => {
            it('should return false for GET requests', () => {
                expect(classifyAction('GET', '/session/123/element/abc123/click')).toBe('unknown');
            });

            it('should return false for screenshot endpoint', () => {
                expect(classifyAction('POST', '/session/123/screenshot')).toBe('unknown');
            });

            it('should return false for source endpoint', () => {
                expect(classifyAction('POST', '/session/123/source')).toBe('unknown');
            });

            it('should return false for window endpoint', () => {
                expect(classifyAction('POST', '/session/123/window')).toBe('unknown');
            });
        });

        describe('edge cases', () => {
            it('should handle element IDs with special characters', () => {
                expect(classifyAction('POST', '/session/123/element/abc-123_xyz/click')).toBe('tap');
            });

            it('should handle UUIDs as element IDs', () => {
                expect(classifyAction('POST', '/session/123/element/550e8400-e29b-41d4-a716-446655440000/click')).toBe('tap');
            });

            it('accepts one trailing slash on Appium action paths', () => {
                expect(classifyAction('POST', '/session/123/element/abc/click/')).toBe('tap');
                expect(classifyAction('POST', '/session/123/back/')).toBe('back');
            });
        });
    });

    describe('recordInteraction', () => {
        it('should create interaction with auto-incrementing ID', () => {
            const interaction1 = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });
            const interaction2 = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/elements',
            });

            expect(interaction1.id).toBe(1);
            expect(interaction2.id).toBe(2);
        });

        it('should add timestamp to interaction', () => {
            const before = new Date().toISOString();
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });
            const after = new Date().toISOString();

            expect(interaction.timestamp).toBeDefined();
            expect(new Date(interaction.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
            expect(new Date(interaction.timestamp).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
        });

        it('should store interaction in history', () => {
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });

            const history = recorder.getHistory();
            expect(history).toHaveLength(1);
            expect(history[0]).toEqual(interaction);
        });

        it('does not retain an untyped request body extension', () => {
            const input: { method: string; path: string } & Record<string, unknown> = {
                method: 'POST',
                path: '/session/123/element',
                body: { using: 'xpath', value: '//button' },
            };
            const interaction = recorder.recordInteraction(input);

            expect('body' in interaction).toBe(false);
        });

        it('should include elementInfo if provided', () => {
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
                elementInfo: { using: 'xpath', value: '//button' },
            });

            expect(interaction.elementInfo).toEqual({ using: 'xpath', value: '//button' });
        });

        it('should emit interaction event', () => {
            const listener = vi.fn();
            recorder.on(listener);

            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });

            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith(
                {
                    type: 'interaction',
                    data: interaction,
                },
            );
        });

        it('ignores deeply nested untyped request data without compromising history', () => {
            const body: Record<string, unknown> = {};
            let cursor = body;
            for (let depth = 0; depth < 5_000; depth++) {
                const child: Record<string, unknown> = {};
                cursor.child = child;
                cursor = child;
            }

            const input: { method: string; path: string } & Record<string, unknown> = {
                method: 'POST', path: '/deep', body,
            };
            const recorded = recorder.recordInteraction(input);
            expect(recorded).toMatchObject({ id: 1, path: '/deep' });
            expect('body' in recorded).toBe(false);
            expect(recorder.recordInteraction({ method: 'POST', path: '/valid' }).id).toBe(2);
        });
    });

    describe('captured-state isolation', () => {
        it('should ignore a stale capture after history is cleared', () => {
            const stale = recorder.recordInteraction({ method: 'POST', path: '/old' });
            recorder.clearHistory();
            const current = recorder.recordInteraction({ method: 'POST', path: '/current' });

            recorder.attachCapturedState(stale.id, { source: '<stale />' });

            expect(current.id).toBeGreaterThan(stale.id);
            expect(recorder.getHistory()).toEqual([current]);
            expect(current.source).toBeUndefined();
        });

        it('should emit the exact captured state to listeners', () => {
            const interaction = recorder.recordInteraction({ method: 'POST', path: '/action' });
            const listener = vi.fn();
            recorder.on(listener);

            recorder.attachCapturedState(interaction.id, { source: '<screen />' });

            const event: ServerEvent = { type: 'interaction', data: interaction };
            expect(listener).toHaveBeenCalledWith(event);
        });

        it('should ignore unknown interaction ids without mutating history', () => {
            const interaction = recorder.recordInteraction({ method: 'POST', path: '/action' });
            const before = JSON.stringify(recorder.getHistory());

            recorder.attachCapturedState(interaction.id + 1, { source: '<unknown />' });

            expect(JSON.stringify(recorder.getHistory())).toBe(before);
        });

        it('should update only the targeted interaction', () => {
            const first = recorder.recordInteraction({ method: 'POST', path: '/first' });
            const second = recorder.recordInteraction({ method: 'POST', path: '/second' });

            recorder.attachCapturedState(first.id, { source: '<first />' });

            expect(first.source).toBe('<first />');
            expect(second.source).toBeUndefined();
        });
    });

    describe('attachCapturedState', () => {
        const base64Png = Buffer.from('fake-png-bytes').toString('base64');

        it('should store screenshot and expose it via screenshotUrl', () => {
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });

            recorder.attachCapturedState(interaction.id, {
                screenshot: base64Png,
                source: '<xml>source</xml>',
            });

            const history = recorder.getHistory();
            expect(history[0].screenshotUrl).toMatch(
                new RegExp(`^/_recorder/api/screenshot/${interaction.id}\\?v=\\d+$`),
            );
            expect(history[0].source).toBe('<xml>source</xml>');
            expect(recorder.getScreenshot(interaction.id)).toEqual(Buffer.from('fake-png-bytes'));
            expect(history[0].captureStatus).toBe('complete');
        });

        it('should not embed base64 screenshot data in the interaction payload', () => {
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });

            recorder.attachCapturedState(interaction.id, { screenshot: base64Png });

            expect(JSON.stringify(recorder.getHistory())).not.toContain(base64Png);
        });

        it('should handle null screenshot and source', () => {
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });

            recorder.attachCapturedState(interaction.id, { screenshot: null, source: null });

            const history = recorder.getHistory();
            expect(history[0].screenshotUrl).toBeUndefined();
            expect(history[0].source).toBeUndefined();
            expect(recorder.getScreenshot(interaction.id)).toBeUndefined();
            expect(history[0].captureStatus).toBe('failed');
        });

        it.each([
            [{ source: '<screen />' }, 'partial'],
            [{ screenshot: base64Png }, 'partial'],
        ] as const)('marks one-sided capture %j as %s', (state, status) => {
            const interaction = recorder.recordInteraction({ method: 'POST', path: '/action' });

            recorder.attachCapturedState(interaction.id, state);

            expect(interaction.captureStatus).toBe(status);
        });

        it.each(['failed', 'skipped'] as const)('marks unavailable captures as %s', status => {
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/action',
                captureStatus: 'pending',
            });

            recorder.markCaptureUnavailable(interaction.id, status);

            expect(interaction.captureStatus).toBe(status);
        });

        it('should emit a single update event', () => {
            const listener = vi.fn();
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });

            recorder.on(listener);
            recorder.attachCapturedState(interaction.id, {
                screenshot: base64Png,
                source: '<xml>source</xml>',
            });

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('should ignore unknown interaction ids', () => {
            const listener = vi.fn();
            recorder.on(listener);

            recorder.attachCapturedState(999, { screenshot: base64Png });

            expect(listener).not.toHaveBeenCalled();
            expect(recorder.getScreenshot(999)).toBeUndefined();
        });
    });

    describe('getHistory', () => {
        it('should return empty array initially', () => {
            expect(recorder.getHistory()).toEqual([]);
        });

        it('should return all recorded interactions', () => {
            recorder.recordInteraction({ method: 'POST', path: '/session/123/element' });
            recorder.recordInteraction({ method: 'POST', path: '/session/123/elements' });
            recorder.recordInteraction({ method: 'POST', path: '/session/123/back' });

            const history = recorder.getHistory();
            expect(history).toHaveLength(3);
        });

        it('should return interactions in order', () => {
            recorder.recordInteraction({ method: 'POST', path: '/path1' });
            recorder.recordInteraction({ method: 'POST', path: '/path2' });
            recorder.recordInteraction({ method: 'POST', path: '/path3' });

            const history = recorder.getHistory();
            expect(history[0].path).toBe('/path1');
            expect(history[1].path).toBe('/path2');
            expect(history[2].path).toBe('/path3');
        });
    });

    describe('clearHistory', () => {
        it('should clear all interactions', () => {
            recorder.recordInteraction({ method: 'POST', path: '/path1' });
            recorder.recordInteraction({ method: 'POST', path: '/path2' });

            recorder.clearHistory();

            expect(recorder.getHistory()).toEqual([]);
        });

        it('should keep IDs monotonic so stale captures cannot target new interactions', () => {
            recorder.recordInteraction({ method: 'POST', path: '/path1' });
            recorder.recordInteraction({ method: 'POST', path: '/path2' });

            recorder.clearHistory();

            const newInteraction = recorder.recordInteraction({ method: 'POST', path: '/path3' });
            expect(newInteraction.id).toBe(3);
        });

        it('should emit clear event', () => {
            const listener = vi.fn();
            recorder.on(listener);

            recorder.clearHistory();

            expect(listener).toHaveBeenCalledWith(
                {
                    type: 'clear',
                    data: null,
                },
            );
        });

        it('should clear stored screenshots', () => {
            const interaction = recorder.recordInteraction({ method: 'POST', path: '/path1' });
            recorder.attachCapturedState(interaction.id, {
                screenshot: Buffer.from('png').toString('base64'),
            });
            expect(recorder.getScreenshot(interaction.id)).toBeDefined();

            recorder.clearHistory();

            expect(recorder.getScreenshot(interaction.id)).toBeUndefined();
        });
    });

    describe('history cap', () => {
        it('should evict oldest interactions (and their screenshots) beyond the cap', () => {
            const first = recorder.recordInteraction({ method: 'POST', path: '/path-first' });
            recorder.attachCapturedState(first.id, {
                screenshot: Buffer.from('png').toString('base64'),
            });

            for (let i = 0; i < 500; i++) {
                recorder.recordInteraction({ method: 'POST', path: `/path-${i}` });
            }

            const history = recorder.getHistory();
            expect(history).toHaveLength(500);
            expect(history[0].path).not.toBe('/path-first');
            expect(recorder.getScreenshot(first.id)).toBeUndefined();
        });

        it('should emit an evict event so connected clients drop evicted interactions', () => {
            const first = recorder.recordInteraction({ method: 'POST', path: '/path-first' });
            for (let i = 0; i < 499; i++) {
                recorder.recordInteraction({ method: 'POST', path: `/path-${i}` });
            }

            const listener = vi.fn();
            recorder.on(listener);

            recorder.recordInteraction({ method: 'POST', path: '/path-overflow' });

            expect(listener).toHaveBeenCalledTimes(2);
            expect(listener).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({ type: 'interaction' }),
            );
            expect(listener).toHaveBeenNthCalledWith(
                2,
                { type: 'evict', data: { ids: [first.id] } },
            );
        });

        it('should evict oldest payloads when retained state exceeds 100 MiB', () => {
            const largeSource = `<Root>${'x'.repeat(9 * 1024 * 1024)}</Root>`;
            const interactions = Array.from({ length: 12 }, (_, index) => {
                const interaction = recorder.recordInteraction({ method: 'POST', path: `/large-${index}` });
                recorder.attachCapturedState(interaction.id, { source: largeSource });
                return interaction;
            });

            const retainedIds = recorder.getHistory().map(interaction => interaction.id);
            expect(retainedIds).not.toContain(interactions[0].id);
            expect(retainedIds).toContain(interactions[4].id);
            expect(recorder.getHistory().length).toBeLessThan(interactions.length);
        });
    });

    describe('event listener management', () => {
        it('should register listener', () => {
            const listener = vi.fn();
            recorder.on(listener);

            recorder.recordInteraction({ method: 'POST', path: '/path' });

            expect(listener).toHaveBeenCalled();
        });

        it('should support multiple listeners', () => {
            const listener1 = vi.fn();
            const listener2 = vi.fn();

            recorder.on(listener1);
            recorder.on(listener2);

            recorder.recordInteraction({ method: 'POST', path: '/path' });

            expect(listener1).toHaveBeenCalled();
            expect(listener2).toHaveBeenCalled();
        });

        it('should unsubscribe listener', () => {
            const listener = vi.fn();
            const unsubscribe = recorder.on(listener);

            unsubscribe();

            recorder.recordInteraction({ method: 'POST', path: '/path' });

            expect(listener).not.toHaveBeenCalled();
        });

        it('should not affect other listeners when unsubscribing', () => {
            const listener1 = vi.fn();
            const listener2 = vi.fn();

            const unsubscribe1 = recorder.on(listener1);
            recorder.on(listener2);

            unsubscribe1();

            recorder.recordInteraction({ method: 'POST', path: '/path' });

            expect(listener1).not.toHaveBeenCalled();
            expect(listener2).toHaveBeenCalled();
        });

        it('should handle unsubscribing same listener multiple times', () => {
            const listener = vi.fn();
            const unsubscribe = recorder.on(listener);

            unsubscribe();
            unsubscribe(); // Should not throw

            expect(listener).not.toHaveBeenCalled();
        });
    });
});
