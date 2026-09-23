/** Version of the captured diff, not an attestation of a hook or its artifacts. */
export async function hashChangeSet(changeSet: { diff: string; files: readonly string[]; error?: string }): Promise<string | undefined> {
    if (changeSet.error) { return undefined; }
    const bytes = new TextEncoder().encode(JSON.stringify([1, [...changeSet.files].sort(), changeSet.diff]));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
