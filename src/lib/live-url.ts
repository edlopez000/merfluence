/**
 * Recognize and decode Mermaid Live Editor URLs.
 *
 * A `https://mermaid.live/edit#pako:…` link carries the entire diagram source
 * in the URL fragment, so importing it needs no network call — and Merfluence
 * never makes one (see the invariant in CLAUDE.md; manifest requests no
 * `external`, no `scopes`). The fragment is either:
 *
 *   #pako:<base64url>   — the classic format: the JSON config is zlib-deflated
 *                         then base64url-encoded by mermaid.live.
 *   #base64:<base64url> — the newer format: plain JSON, base64url only.
 *
 * Both decode to a JSON object of the shape `{ code: string, … }`, and it is
 * `state.code` that holds the Mermaid source.
 *
 * The only decoding primitives used are browser built-ins: atob (for the
 * base64url) and DecompressionStream('deflate') (for the zlib layer — the very
 * stream mermaid.live itself compresses with). No pako/fflate dependency,
 * which keeps test/prod-deps-fingerprint.test.js quiet.
 */

// The host we recognise fragments from. Everything else is rejected loudly
// rather than fetched — fetching a fallback would need egress, and the whole
// point of this feature is that it needs none.
const LIVE_HOST = 'mermaid.live';

/**
 * A failure whose message is written FOR the editor panel, not for a log.
 *
 * The panel prints these verbatim, because they point at different fixes ("that
 * link has no diagram in it" is a different problem from "couldn't decode it"),
 * so the class is what separates copy we chose from an internal error that
 * merely escaped — the latter must never be shown. Anything thrown from here
 * that is NOT one of these is a bug, and the panel says so generically.
 */
export class LiveUrlError extends Error {}

/** What a mermaid.live fragment carries: which encoding, and the payload. */
type LiveFragment = { format: 'pako' | 'base64'; payload: string };

/**
 * Parse `text` as a Mermaid Live Editor diagram link, or null when it is not one.
 *
 * The WHOLE trimmed text has to be the URL. Text that merely *contains* a
 * mermaid.live link — a diagram with a `click … href` line, a note with a link
 * under it — is ordinary text and must paste as text, not be swallowed and
 * replace the document.
 *
 * The host is checked by parsing, not by matching: `hostname` must equal
 * mermaid.live exactly, so neither a subdomain (`mermaid.live.evil.test`) nor a
 * URL that merely mentions the host in a query (`?to=://mermaid.live/…`) passes.
 * That check is the security boundary — everything else about the URL (path,
 * query, trailing slash, missing scheme) is deliberately not our business,
 * because the fragment is the only part we consume.
 */
function parseLiveUrl(text: string): LiveFragment | null {
  const value = String(text ?? '').trim();
  // One URL and nothing else. Any inner whitespace means this is prose or
  // diagram source, not a link, and the caller must let it through untouched.
  if (!value || /\s/.test(value)) return null;

  let url: URL;
  try {
    // A bare "mermaid.live/edit#…" pasted without the scheme is still the link,
    // so supply https:// when there is no scheme at all. Anything that already
    // carries one is parsed as-is, so a non-http scheme fails the check below
    // rather than being re-homed onto https.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname.toLowerCase() !== LIVE_HOST) return null;

  // url.hash is the fragment of THIS url, '#' included — never an unrelated '#'
  // somewhere else in the pasted text.
  const match = /^(pako|base64):(.+)$/is.exec(url.hash.slice(1));
  if (!match) return null;
  return { format: match[1].toLowerCase() as LiveFragment['format'], payload: match[2] };
}

/**
 * True when `text` is a Mermaid Live Editor URL whose fragment carries a
 * diagram (either the classic `#pako:` or the newer `#base64:`).
 *
 * Anything else — a mermaid.live page without a diagram fragment, any other
 * host, a relative string, text that merely contains such a link — is not our
 * lane, and the caller falls through to ordinary paste / ordinary drop.
 */
export function isMermaidLiveUrl(text: string): boolean {
  return parseLiveUrl(text) !== null;
}

/**
 * Decode a base64url string to bytes. base64url is the standard base64 alphabet
 * with `-`/`_` substituted for `+`/`/` and the trailing `=` padding stripped.
 * atob() is strict about both, so translate back before decoding.
 */
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Base64Url-decode a string payload into a UTF-8 string. */
function decodeBase64Url(value: string): string {
  // DecompressionStream gives us a Uint8Array; the stream's text decoder friend
  // lives in TextDecoder. Feeding it a fresh typed view mirrors how the browser
  // itself would decode the body of a fetched resource.
  return new TextDecoder().decode(base64UrlToBytes(value));
}

/**
 * Ceiling on what a `#pako:` fragment may inflate to. Deflate reaches ratios
 * around 1000:1 on repetitive input, so a ~1MB link would otherwise expand to
 * ~1GB and take the editor down with it — the reason to cap is the ratio, not
 * the size, which is why the file-drop path needs no equivalent. 512KB is
 * several times the largest diagram anyone writes by hand, and well past what
 * would still fit in macro config once saved. (Not a sibling of cache.ts's
 * MAX_SVG_BYTES: that one gates whether a render is worth caching.)
 */
const MAX_INFLATED_BYTES = 512 * 1024;

/**
 * Inflate a zlib-deflated buffer using the platform's DecompressionStream.
 *
 * 'deflate' is the raw zlib stream that mermaid.live's `#pako:` format stores
 * (pako.deflate produces the same wrapper). DecompressionStream is available in
 * every modern Chromium — the engine the config iframe runs in — and, unlike
 * pako/fflate, adds no dependency. jsdom does not implement it, which is why
 * the coverage for this path lives in the browser test project.
 *
 * The output is read chunk by chunk rather than buffered whole, so an oversized
 * payload is abandoned partway instead of being decompressed in full and only
 * then measured. The cap has to bound the work, not just the result.
 */
async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  // Decoded incrementally with stream: true, so a multi-byte character split
  // across two chunks still decodes correctly.
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INFLATED_BYTES) {
        throw new LiveUrlError('That Mermaid Live link is too big to import.');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releases the underlying stream when we bail out early; a no-op once the
    // reader has run to completion.
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

/**
 * Decode a Mermaid Live Editor URL into its diagram source.
 *
 * @throws {LiveUrlError} If the text is not a recognised mermaid.live `#pako:` /
 *   `#base64:` fragment, if the payload is corrupt, if it inflates past
 *   MAX_INFLATED_BYTES, or if the decoded JSON is not the expected
 *   `{ code: string }` shape. Every failure this function
 *   raises deliberately is a LiveUrlError, so callers can tell those from a bug
 *   escaping. The underlying failure is kept as `cause`. Nothing is ever fetched.
 *
 * @returns `state.code`, the diagram source.
 */
export async function decodeLiveUrl(text: string): Promise<string> {
  const fragment = parseLiveUrl(text);
  if (!fragment) {
    throw new LiveUrlError('Not a Mermaid Live Editor URL.');
  }

  let json: string;
  try {
    // Both formats share the same outer shape: base64url-encoded JSON. The only
    // difference is whether that JSON was zlib-deflated first.
    //   base64: JSON sits in the fragment directly.
    //   pako:   JSON sits behind a zlib deflate stream; inflate first.
    json =
      fragment.format === 'pako'
        ? await inflate(base64UrlToBytes(fragment.payload))
        : decodeBase64Url(fragment.payload);
  } catch (cause) {
    // A LiveUrlError from in there was already worded for the panel (the size
    // cap), and says something "couldn't decode it" does not. Only genuine
    // decode failures get flattened into the generic message.
    if (cause instanceof LiveUrlError) throw cause;
    throw new LiveUrlError(`Couldn't decode that Mermaid Live link.`, { cause });
  }

  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch (cause) {
    throw new LiveUrlError(`Couldn't decode that Mermaid Live link.`, { cause });
  }

  // The shape mermaid.live actually stores: { code, … }. Anything else means
  // the payload is not a Live Editor state even though it parsed as JSON. An
  // empty (or blank) code is rejected for a sharper reason: importing it would
  // silently wipe whatever the user already had in the editor. Same guard the
  // file-drop path applies to extractMermaidSource's result.
  const code = (state as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !code.trim()) {
    throw new LiveUrlError('That Mermaid Live link has no diagram in it.');
  }

  return code;
}
