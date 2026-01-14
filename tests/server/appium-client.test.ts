import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AppiumClient } from '../../src/server/appium-client';

describe('AppiumClient', () => {
    let client: AppiumClient;
    const mockAppiumUrl = 'http://localhost:4723';

    beforeEach(() => {
        client = new AppiumClient(mockAppiumUrl);
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should create client with provided appium URL', () => {
            const customClient = new AppiumClient('http://custom:8080');
            expect(customClient).toBeInstanceOf(AppiumClient);
        });
    });

    describe('fetchFromAppium', () => {
        it('should fetch data from correct URL', async () => {
            const mockResponse = { value: 'screenshot_data' };
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(mockResponse),
            } as unknown as Response);

            await client.fetchFromAppium('session123', 'screenshot');

            expect(fetch).toHaveBeenCalledWith(
                'http://localhost:4723/session/session123/screenshot'
            );
        });

        it('should return value from response', async () => {
            const mockResponse = { value: 'screenshot_data' };
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(mockResponse),
            } as unknown as Response);

            const result = await client.fetchFromAppium('session123', 'screenshot');

            expect(result).toBe('screenshot_data');
        });

        it('should return null if response has no value property', async () => {
            const mockResponse = { data: 'something_else' };
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(mockResponse),
            } as unknown as Response);

            const result = await client.fetchFromAppium('session123', 'screenshot');

            expect(result).toBeNull();
        });

        it('should return null if response is null', async () => {
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(null),
            } as unknown as Response);

            const result = await client.fetchFromAppium('session123', 'screenshot');

            expect(result).toBeNull();
        });

        it('should return null on fetch error', async () => {
            vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

            const result = await client.fetchFromAppium('session123', 'screenshot');

            expect(result).toBeNull();
        });

        it('should return null on JSON parse error', async () => {
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
            } as unknown as Response);

            const result = await client.fetchFromAppium('session123', 'screenshot');

            expect(result).toBeNull();
        });

        it('should handle different endpoints', async () => {
            const mockResponse = { value: '<xml>source</xml>' };
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(mockResponse),
            } as unknown as Response);

            await client.fetchFromAppium('session456', 'source');

            expect(fetch).toHaveBeenCalledWith(
                'http://localhost:4723/session/session456/source'
            );
        });

        it('should handle value being an object', async () => {
            const mockValue = { element: 'id123', attributes: { visible: true } };
            const mockResponse = { value: mockValue };
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(mockResponse),
            } as unknown as Response);

            const result = await client.fetchFromAppium('session123', 'element');

            expect(result).toEqual(mockValue);
        });

        it('should handle value being an array', async () => {
            const mockValue = [{ id: '1' }, { id: '2' }];
            const mockResponse = { value: mockValue };
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(mockResponse),
            } as unknown as Response);

            const result = await client.fetchFromAppium('session123', 'elements');

            expect(result).toEqual(mockValue);
        });

        it('should handle value being empty string', async () => {
            const mockResponse = { value: '' };
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(mockResponse),
            } as unknown as Response);

            const result = await client.fetchFromAppium('session123', 'endpoint');

            expect(result).toBe('');
        });

        it('should handle value being false', async () => {
            const mockResponse = { value: false };
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(mockResponse),
            } as unknown as Response);

            const result = await client.fetchFromAppium('session123', 'enabled');

            expect(result).toBe(false);
        });

        it('should handle value being zero', async () => {
            const mockResponse = { value: 0 };
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue(mockResponse),
            } as unknown as Response);

            const result = await client.fetchFromAppium('session123', 'count');

            expect(result).toBe(0);
        });
    });

    describe('captureState', () => {
        it('should fetch both screenshot and source in parallel', async () => {
            const screenshotResponse = { value: 'base64_screenshot' };
            const sourceResponse = { value: '<xml>page source</xml>' };

            vi.mocked(fetch)
                .mockResolvedValueOnce({
                    json: vi.fn().mockResolvedValue(screenshotResponse),
                } as unknown as Response)
                .mockResolvedValueOnce({
                    json: vi.fn().mockResolvedValue(sourceResponse),
                } as unknown as Response);

            const result = await client.captureState('session123');

            expect(fetch).toHaveBeenCalledTimes(2);
            expect(result.screenshot).toBe('base64_screenshot');
            expect(result.source).toBe('<xml>page source</xml>');
        });

        it('should return undefined screenshot if fetch fails', async () => {
            vi.mocked(fetch)
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValueOnce({
                    json: vi.fn().mockResolvedValue({ value: '<xml>source</xml>' }),
                } as unknown as Response);

            const result = await client.captureState('session123');

            expect(result.screenshot).toBeNull();
            expect(result.source).toBe('<xml>source</xml>');
        });

        it('should return undefined source if fetch fails', async () => {
            vi.mocked(fetch)
                .mockResolvedValueOnce({
                    json: vi.fn().mockResolvedValue({ value: 'base64_screenshot' }),
                } as unknown as Response)
                .mockRejectedValueOnce(new Error('Network error'));

            const result = await client.captureState('session123');

            expect(result.screenshot).toBe('base64_screenshot');
            expect(result.source).toBeNull();
        });

        it('should return both undefined if both fetches fail', async () => {
            vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

            const result = await client.captureState('session123');

            expect(result.screenshot).toBeNull();
            expect(result.source).toBeNull();
        });

        it('should call correct endpoints', async () => {
            vi.mocked(fetch).mockResolvedValue({
                json: vi.fn().mockResolvedValue({ value: 'data' }),
            } as unknown as Response);

            await client.captureState('session789');

            expect(fetch).toHaveBeenCalledWith(
                'http://localhost:4723/session/session789/screenshot'
            );
            expect(fetch).toHaveBeenCalledWith(
                'http://localhost:4723/session/session789/source'
            );
        });
    });
});
