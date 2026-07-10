/**
 * Simple XML pretty-printer shared by the inspector view and copy actions.
 * Builds an array and joins once instead of concatenating strings per line.
 */
export function formatXml(xml: string): string {
    if (!xml) return '';

    const out: string[] = [];
    let indent = 0;
    const lines = xml.replace(/></g, '>\n<').split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('</')) {
            indent = Math.max(0, indent - 1);
        }

        out.push('  '.repeat(indent) + trimmed);

        if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.endsWith('/>') && !trimmed.includes('</')) {
            indent++;
        }
    }

    return out.length > 0 ? out.join('\n') + '\n' : '';
}
