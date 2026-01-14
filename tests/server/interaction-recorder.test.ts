import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InteractionRecorder } from '../../src/server/interaction-recorder';
import type { ServerEvent, Interaction } from '../../src/server/types';

describe('InteractionRecorder', () => {
    let recorder: InteractionRecorder;

    beforeEach(() => {
        recorder = new InteractionRecorder();
    });

    describe('shouldRecord', () => {
        it('should return true for POST requests', () => {
            expect(recorder.shouldRecord('POST', '/session/123/element')).toBe(true);
        });

        it('should return false for GET requests', () => {
            expect(recorder.shouldRecord('GET', '/session/123/element')).toBe(false);
        });

        it('should return false for PUT requests', () => {
            expect(recorder.shouldRecord('PUT', '/session/123/element')).toBe(false);
        });

        it('should return false for DELETE requests', () => {
            expect(recorder.shouldRecord('DELETE', '/session/123/element')).toBe(false);
        });

        it('should return false for PATCH requests', () => {
            expect(recorder.shouldRecord('PATCH', '/session/123/element')).toBe(false);
        });
    });

    describe('isActionEndpoint', () => {
        describe('POST method', () => {
            it('should identify click endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/element/abc123/click')).toBe(true);
            });

            it('should identify value endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/element/abc123/value')).toBe(true);
            });

            it('should identify clear endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/element/abc123/clear')).toBe(true);
            });

            it('should identify element endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/element')).toBe(true);
            });

            it('should identify elements endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/elements')).toBe(true);
            });

            it('should identify touch/perform endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/touch/perform')).toBe(true);
            });

            it('should identify actions endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/actions')).toBe(true);
            });

            it('should identify back endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/back')).toBe(true);
            });

            it('should identify forward endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/forward')).toBe(true);
            });

            it('should identify refresh endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/refresh')).toBe(true);
            });
        });

        describe('DELETE method', () => {
            it('should identify action endpoints for DELETE', () => {
                expect(recorder.isActionEndpoint('DELETE', '/session/123/element/abc123/click')).toBe(true);
            });
        });

        describe('non-action endpoints', () => {
            it('should return false for GET requests', () => {
                expect(recorder.isActionEndpoint('GET', '/session/123/element/abc123/click')).toBe(false);
            });

            it('should return false for screenshot endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/screenshot')).toBe(false);
            });

            it('should return false for source endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/source')).toBe(false);
            });

            it('should return false for window endpoint', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/window')).toBe(false);
            });
        });

        describe('edge cases', () => {
            it('should handle element IDs with special characters', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/element/abc-123_xyz/click')).toBe(true);
            });

            it('should handle UUIDs as element IDs', () => {
                expect(recorder.isActionEndpoint('POST', '/session/123/element/550e8400-e29b-41d4-a716-446655440000/click')).toBe(true);
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

        it('should include body if provided', () => {
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
                body: { using: 'xpath', value: '//button' },
            });

            expect(interaction.body).toEqual({ using: 'xpath', value: '//button' });
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
            expect(listener).toHaveBeenCalledWith({
                type: 'interaction',
                data: interaction,
            });
        });
    });

    describe('updateInteraction', () => {
        it('should update existing interaction', () => {
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });

            recorder.updateInteraction(interaction.id, {
                screenshot: 'base64screenshot',
                source: '<xml>source</xml>',
            });

            const history = recorder.getHistory();
            expect(history[0].screenshot).toBe('base64screenshot');
            expect(history[0].source).toBe('<xml>source</xml>');
        });

        it('should emit event on update', () => {
            const listener = vi.fn();
            const interaction = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });

            recorder.on(listener);
            recorder.updateInteraction(interaction.id, {
                screenshot: 'base64screenshot',
            });

            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'interaction',
                    data: expect.objectContaining({
                        screenshot: 'base64screenshot',
                    }),
                })
            );
        });

        it('should not emit event for non-existent interaction', () => {
            const listener = vi.fn();
            recorder.on(listener);

            recorder.updateInteraction(999, {
                screenshot: 'base64screenshot',
            });

            expect(listener).not.toHaveBeenCalled();
        });

        it('should not affect other interactions', () => {
            const interaction1 = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/element',
            });
            const interaction2 = recorder.recordInteraction({
                method: 'POST',
                path: '/session/123/elements',
            });

            recorder.updateInteraction(interaction1.id, {
                screenshot: 'base64screenshot',
            });

            const history = recorder.getHistory();
            expect(history[0].screenshot).toBe('base64screenshot');
            expect(history[1].screenshot).toBeUndefined();
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

        it('should reset interaction ID counter', () => {
            recorder.recordInteraction({ method: 'POST', path: '/path1' });
            recorder.recordInteraction({ method: 'POST', path: '/path2' });

            recorder.clearHistory();

            const newInteraction = recorder.recordInteraction({ method: 'POST', path: '/path3' });
            expect(newInteraction.id).toBe(1);
        });

        it('should emit clear event', () => {
            const listener = vi.fn();
            recorder.on(listener);

            recorder.clearHistory();

            expect(listener).toHaveBeenCalledWith({
                type: 'clear',
                data: null,
            });
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
