import DOMPurify = require('@theia/core/shared/dompurify');
import markdownit = require('@theia/core/shared/markdown-it');
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';

export const POIESIS_FILE_LINK_ATTRIBUTE = 'data-poiesis-file-uri';
export const POIESIS_EXTERNAL_LINK_ATTRIBUTE = 'data-poiesis-external-uri';
export const POIESIS_INLINE_IMAGE_ATTRIBUTE = 'data-poiesis-inline-image';

const workspaceImageExtensionPattern = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const workspaceHtmlExtensionPattern = /\.html?$/i;

const markdown = markdownit({
    breaks: true,
    html: false,
    linkify: false,
    typographer: false
});

const bareFilePathPattern = /(?<![A-Za-z0-9_@()+./\\-])(?:[A-Za-z]:[\\/](?:[^\\/\s<>:"|?*]+[\\/])*[^\\/\s<>:"|?*]+\.[A-Za-z0-9]{1,16}|(?:\.{1,2}[\\/])?(?:(?:[A-Za-z0-9_@()+.-]+)[\\/])+(?:[A-Za-z0-9_@()+.-]+)\.[A-Za-z0-9]{1,16}|(?:[A-Za-z0-9_@()+.-]+)\.[A-Za-z0-9]{1,16})(?![A-Za-z0-9_@()+./\\-])/g;

export interface WorkspaceRichContentReferences {
    imageUris: URI[];
    htmlUris: URI[];
}

/**
 * Renders markdown without trusting media URLs supplied by the model. Image
 * sources are injected only from the application-owned map after sanitizing.
 */
export function renderSafeMarkdown(
    content: string,
    workspaceUri: string | undefined,
    workspaceImageSources: ReadonlyMap<string, string> = new Map()
): string {
    const workspace = workspaceUri ? new URI(workspaceUri).normalizePath() : undefined;
    const host = document.createElement('div');
    // markdown-it escapes all source HTML because html is deliberately disabled.
    host.innerHTML = markdown.render(content || '…');
    prepareMarkdownImages(host, workspace, workspaceImageSources);
    prepareMarkdownLinks(host, workspace);
    linkBareWorkspacePaths(host, workspace);
    promoteBareWorkspaceImages(host, workspaceImageSources);
    const sanitized = DOMPurify.sanitize(host.innerHTML, {
        ALLOWED_TAGS: ['a', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'li', 'ol', 'p', 'pre', 'strong', 'ul'],
        ALLOWED_ATTR: ['alt', 'href', 'src', 'title', 'rel', POIESIS_FILE_LINK_ATTRIBUTE, POIESIS_EXTERNAL_LINK_ATTRIBUTE,
            POIESIS_INLINE_IMAGE_ATTRIBUTE],
        ALLOW_DATA_ATTR: false
    });
    const safeHost = document.createElement('div');
    safeHost.innerHTML = sanitized;
    for (const image of Array.from(safeHost.querySelectorAll(`img[${POIESIS_INLINE_IMAGE_ATTRIBUTE}]`))) {
        const fileUri = decodedAttribute(image.getAttribute(POIESIS_INLINE_IMAGE_ATTRIBUTE));
        const source = fileUri ? workspaceImageSources.get(fileUri) : undefined;
        if (!source) {
            image.replaceWith(fileLinkCode(fileUri ? new URI(fileUri).path.fsPath() : image.getAttribute('alt') ?? 'image'));
            continue;
        }
        // This assignment happens after DOMPurify by design: only a Blob URL
        // created by the Application from a verified Workspace file can enter src.
        image.setAttribute('src', source);
    }
    return safeHost.innerHTML;
}

/** Finds only markdown image targets, markdown links, and bare paths. */
export function collectWorkspaceRichContentReferences(
    content: string,
    workspaceUri: string | undefined
): WorkspaceRichContentReferences {
    const workspace = workspaceUri ? new URI(workspaceUri).normalizePath() : undefined;
    const host = document.createElement('div');
    host.innerHTML = markdown.render(content || '');
    const imageUris = new Map<string, URI>();
    const htmlUris = new Map<string, URI>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let current: Node | null;
    while ((current = walker.nextNode())) {
        if (current instanceof HTMLImageElement) {
            addWorkspaceReference(current.getAttribute('src') ?? '', workspace, workspaceImageExtensionPattern, imageUris);
        } else if (current instanceof HTMLAnchorElement) {
            addWorkspaceReference(current.getAttribute('href') ?? '', workspace, workspaceHtmlExtensionPattern, htmlUris);
        } else if (current instanceof Text && current.parentElement && !current.parentElement.closest('a, code, pre')) {
            const text = current.data;
            for (const match of text.matchAll(bareFilePathPattern)) {
                const rawPath = match[0];
                addWorkspaceReference(rawPath, workspace, workspaceHtmlExtensionPattern, htmlUris);
                if (current.parentElement.tagName === 'P' && current.parentElement.textContent?.trim() === rawPath) {
                    addWorkspaceReference(rawPath, workspace, workspaceImageExtensionPattern, imageUris);
                }
            }
        }
    }
    return { imageUris: [...imageUris.values()], htmlUris: [...htmlUris.values()] };
}

function prepareMarkdownImages(
    host: HTMLElement,
    workspace: URI | undefined,
    workspaceImageSources: ReadonlyMap<string, string>
): void {
    for (const image of Array.from(host.querySelectorAll('img'))) {
        const rawSource = image.getAttribute('src') ?? '';
        const fileUri = resolveWorkspaceFile(rawSource, workspace);
        if (fileUri && workspaceImageExtensionPattern.test(fileUri.path.base) && workspaceImageSources.has(fileUri.toString())) {
            image.removeAttribute('src');
            image.setAttribute(POIESIS_INLINE_IMAGE_ATTRIBUTE, encodeURIComponent(fileUri.toString()));
            const anchor = document.createElement('a');
            prepareFileAnchor(anchor, fileUri);
            image.replaceWith(anchor);
            anchor.append(image);
            continue;
        }
        const alt = image.getAttribute('alt')?.trim() || decodedHref(rawSource) || 'image';
        if (isHttpHref(rawSource)) {
            const anchor = document.createElement('a');
            anchor.href = rawSource;
            anchor.textContent = alt;
            anchor.setAttribute(POIESIS_EXTERNAL_LINK_ATTRIBUTE, rawSource);
            anchor.setAttribute('rel', 'noopener noreferrer');
            anchor.setAttribute('title', rawSource);
            image.replaceWith(anchor);
        } else if (fileUri) {
            const anchor = document.createElement('a');
            prepareFileAnchor(anchor, fileUri);
            anchor.append(fileLinkCode(alt));
            image.replaceWith(anchor);
        } else {
            image.replaceWith(fileLinkCode(alt));
        }
    }
}

function prepareMarkdownLinks(host: HTMLElement, workspace: URI | undefined): void {
    for (const anchor of Array.from(host.querySelectorAll('a'))) {
        if (anchor.hasAttribute(POIESIS_FILE_LINK_ATTRIBUTE) || anchor.hasAttribute(POIESIS_EXTERNAL_LINK_ATTRIBUTE)) {
            continue;
        }
        const href = anchor.getAttribute('href') ?? '';
        if (isHttpHref(href)) {
            anchor.setAttribute(POIESIS_EXTERNAL_LINK_ATTRIBUTE, href);
            anchor.setAttribute('rel', 'noopener noreferrer');
            anchor.setAttribute('title', href);
            continue;
        }
        const fileUri = resolveWorkspaceFile(href, workspace);
        if (fileUri) {
            prepareFileAnchor(anchor, fileUri);
            continue;
        }
        replaceWithCode(anchor, decodedHref(href));
    }
}

function promoteBareWorkspaceImages(host: HTMLElement, workspaceImageSources: ReadonlyMap<string, string>): void {
    for (const paragraph of Array.from(host.querySelectorAll('p'))) {
        if (paragraph.children.length !== 1) {
            continue;
        }
        const anchor = paragraph.firstElementChild;
        if (!(anchor instanceof HTMLAnchorElement) || anchor.textContent?.trim() !== paragraph.textContent?.trim()) {
            continue;
        }
        if (anchor.querySelector('img')) {
            continue;
        }
        const fileUri = decodedAttribute(anchor.getAttribute(POIESIS_FILE_LINK_ATTRIBUTE));
        if (!fileUri || !workspaceImageExtensionPattern.test(new URI(fileUri).path.base) || !workspaceImageSources.has(fileUri)) {
            continue;
        }
        const image = document.createElement('img');
        image.alt = paragraph.textContent?.trim() || new URI(fileUri).path.base;
        image.setAttribute(POIESIS_INLINE_IMAGE_ATTRIBUTE, encodeURIComponent(fileUri));
        anchor.replaceChildren(image);
    }
}

function linkBareWorkspacePaths(host: HTMLElement, workspace: URI | undefined): void {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let current: Node | null;
    while ((current = walker.nextNode())) {
        const parent = current.parentElement;
        if (current instanceof Text && parent && !parent.closest('a, code, pre')) {
            textNodes.push(current);
        }
    }
    for (const textNode of textNodes) {
        const text = textNode.data;
        const matches = [...text.matchAll(bareFilePathPattern)];
        if (!matches.length) {
            continue;
        }
        const fragment = document.createDocumentFragment();
        let offset = 0;
        for (const match of matches) {
            const index = match.index ?? 0;
            const rawPath = match[0];
            fragment.append(text.slice(offset, index));
            const code = document.createElement('code');
            code.textContent = rawPath;
            const fileUri = resolveWorkspaceFile(rawPath, workspace);
            if (fileUri) {
                const anchor = document.createElement('a');
                anchor.href = '#';
                anchor.setAttribute(POIESIS_FILE_LINK_ATTRIBUTE, encodeURIComponent(fileUri.toString()));
                anchor.title = fileUri.path.fsPath();
                anchor.append(code);
                fragment.append(anchor);
            } else {
                fragment.append(code);
            }
            offset = index + rawPath.length;
        }
        fragment.append(text.slice(offset));
        textNode.replaceWith(fragment);
    }
}

function resolveWorkspaceFile(rawHref: string, workspace: URI | undefined): URI | undefined {
    if (!workspace || !rawHref || rawHref === '#') {
        return undefined;
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(rawHref).trim();
    } catch {
        return undefined;
    }
    let candidate: URI;
    if (/^[A-Za-z]:[\\/]/.test(decoded)) {
        candidate = FileUri.create(decoded);
    } else if (/^file:/i.test(decoded)) {
        candidate = new URI(decoded);
    } else if (decoded.startsWith('/')) {
        candidate = FileUri.create(decoded);
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) {
        return undefined;
    } else {
        candidate = workspace.resolve(decoded.replaceAll('\\', '/'));
    }
    candidate = candidate.withQuery('').withFragment('').normalizePath();
    return workspace.isEqualOrParent(candidate, false) ? candidate : undefined;
}

function addWorkspaceReference(
    rawPath: string,
    workspace: URI | undefined,
    extensionPattern: RegExp,
    target: Map<string, URI>
): void {
    const uri = resolveWorkspaceFile(rawPath, workspace);
    if (uri && extensionPattern.test(uri.path.base)) {
        target.set(uri.toString(), uri);
    }
}

function prepareFileAnchor(anchor: HTMLAnchorElement, fileUri: URI): void {
    anchor.setAttribute('href', '#');
    anchor.setAttribute(POIESIS_FILE_LINK_ATTRIBUTE, encodeURIComponent(fileUri.toString()));
    anchor.setAttribute('title', fileUri.path.fsPath());
}

function fileLinkCode(content: string): HTMLElement {
    const code = document.createElement('code');
    code.textContent = content;
    return code;
}

function replaceWithCode(anchor: HTMLAnchorElement, content = anchor.textContent ?? ''): void {
    const code = document.createElement('code');
    code.textContent = content;
    anchor.replaceWith(code);
}

function decodedHref(href: string): string {
    try {
        return decodeURIComponent(href);
    } catch {
        return href;
    }
}

function decodedAttribute(value: string | null): string | undefined {
    if (!value) {
        return undefined;
    }
    try {
        return decodeURIComponent(value);
    } catch {
        return undefined;
    }
}

function isHttpHref(href: string): boolean {
    return /^https?:\/\//i.test(href);
}
