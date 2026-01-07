export class AppiumClient {
    constructor(private appiumUrl: string) { }

    async fetchFromAppium(sessionId: string, endpoint: string): Promise<any> {
        try {
            const response = await fetch(`${this.appiumUrl}/session/${sessionId}/${endpoint}`);
            const data = await response.json();
            if (data && typeof data === 'object' && 'value' in data) {
                return data.value;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    async captureState(sessionId: string): Promise<{ screenshot?: string; source?: string }> {
        const [screenshot, source] = await Promise.all([
            this.fetchFromAppium(sessionId, 'screenshot'),
            this.fetchFromAppium(sessionId, 'source'),
        ]);
        return { screenshot, source };
    }
}
