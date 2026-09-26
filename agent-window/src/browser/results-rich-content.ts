import DOMPurify = require('@theia/core/shared/dompurify');
import { POIESIS_FONT_MONO, POIESIS_FONT_SANS } from './typography';

/** Scripts belong to the document and execute only in the opaque frame. */
export function sanitizeResultsHtml(html: string, allowExternalResources = false): string {
    const clean = DOMPurify.sanitize(html, {
        WHOLE_DOCUMENT: true, USE_PROFILES: { html: true, svg: true }, ADD_TAGS: ['use', 'script', ...(allowExternalResources ? ['link'] : [])],
        FORBID_TAGS: ['foreignObject', 'iframe', 'object', 'embed', ...(!allowExternalResources ? ['link'] : []), 'meta', 'base', 'form', 'input', 'textarea', 'select', 'video', 'audio', 'source'],
        FORBID_ATTR: ['srcdoc', 'srcset', 'autofocus', 'formaction', 'action', 'ping']
    });
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    for (const node of Array.from(doc.querySelectorAll('*'))) {
        for (const attribute of Array.from(node.attributes)) {
            const name = attribute.name.toLowerCase();
            if (name.startsWith('on') || (name === 'src' || name === 'href' || name === 'xlink:href')
                && !/^#|^data:image\//i.test(attribute.value.trim())
                && !(allowExternalResources && /^(?:https?:)?\/\//i.test(attribute.value.trim()))) {
                node.removeAttribute(attribute.name);
            }
        }
    }
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

export const RESULTS_FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";
export const RESULTS_RICH_STYLE = `
:root { --results-bg: #f1efe8; --results-fg: #262721; --results-muted: #61645c; --results-border: #d6d3c9; --results-accent: #386e63; --results-font-sans: ${POIESIS_FONT_SANS}; --results-font-mono: ${POIESIS_FONT_MONO}; --results-scrollbar-opacity: 22%; --results-scrollbar-hover-opacity: 40%; color-scheme: light; }
:root[data-theme="dark"] { --results-bg: #242722; --results-fg: #eceee8; --results-muted: #b5b9af; --results-border: #50574b; --results-accent: #91cdb9; --results-scrollbar-opacity: 18%; --results-scrollbar-hover-opacity: 35%; color-scheme: dark; }
::-webkit-scrollbar { width: 10px !important; height: 10px !important; }
/* Paint the track with the page color: a transparent track shows the host frame element behind the iframe. */
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: var(--results-bg) !important; }
::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
::-webkit-scrollbar-thumb { border: 3px solid transparent !important; border-radius: 999px !important; background: color-mix(in srgb, var(--results-fg) var(--results-scrollbar-opacity), transparent) padding-box !important; }
::-webkit-scrollbar-thumb:hover { border-width: 2px !important; background: color-mix(in srgb, var(--results-fg) var(--results-scrollbar-hover-opacity), transparent) padding-box !important; }
`;

/** Add only frame policy, theme tokens and scrollbar styling. */
export function resultsFrameHtml(html: string, theme: 'light' | 'dark', allowExternalResources = false): string {
    const doc = new DOMParser().parseFromString(sanitizeResultsHtml(html, allowExternalResources), 'text/html');
    doc.documentElement.dataset.theme = theme;
    if (!allowExternalResources) {
        const policy = doc.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        policy.content = RESULTS_FRAME_CSP;
        doc.head.prepend(policy);
    }
    const style = doc.createElement('style');
    style.textContent = RESULTS_RICH_STYLE;
    doc.head.append(style);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

/** A consumed document remains consumed across rerenders and navigation. */
export class ResultsFrameRetryGate {
    protected readonly consumed = new Set<string>();
    take(document: string | undefined, generating: boolean): boolean {
        if (!document || generating || this.consumed.has(document)) { return false; }
        this.consumed.add(document);
        return true;
    }
}
