import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeLiveUrl, isMermaidLiveUrl, LiveUrlError } from '../../src/lib/live-url.js';

/**
 * The Mermaid Live Editor import, where the code physically has to run.
 *
 * decodeLiveUrl needs DecompressionStream (and atob/TextDecoder against real
 * bytes), and jsdom implements none of those — which is why this lives in the
 * Chromium browser project. The editor *wiring* (paste and text/uri-list drop
 * feeding the decoded source into the editor) is exercised in
 * test/config-app.test.jsx with decodeLiveUrl stubbed, exactly as that file
 * stubs renderDiagram for the browser-only render pipeline; the decoder
 * itself, tested here, is the browser-only half.
 *
 * The payloads are built the same way mermaid.live builds them: a #pako:
 * fragment is the Live Editor state JSON zlib-deflated (CompressionStream's
 * 'deflate' emits the same zlib stream as pako.deflate) and base64url-encoded;
 * a #base64: fragment is plain JSON, base64url only.
 */

/** base64url-encode bytes — the alphabet mermaid.live uses for its fragments. */
function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a real `#pako:` mermaid.live URL: zlib-deflated JSON, base64url. */
async function pakoUrl(source) {
  const json = new TextEncoder().encode(JSON.stringify({ code: source }));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate'));
  const deflated = new Uint8Array(await new Response(stream).arrayBuffer());
  return `https://mermaid.live/edit#pako:${toBase64Url(deflated)}`;
}

/**
 * Build a `#pako:` URL whose payload inflates to roughly `codeBytes` of diagram
 * source — a deflate bomb, in the shape mermaid.live's own format would carry
 * one. The JSON is streamed into the compressor a chunk at a time rather than
 * built as one giant string, so the test itself stays cheap while the payload
 * it produces is not.
 */
async function pakoBombUrl(codeBytes) {
  const encoder = new TextEncoder();
  const chunk = encoder.encode('a'.repeat(64 * 1024));
  const chunks = Math.ceil(codeBytes / chunk.length);
  let sent = 0;
  const json = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"code":"'));
    },
    pull(controller) {
      if (sent >= chunks) {
        controller.enqueue(encoder.encode('"}'));
        controller.close();
        return;
      }
      sent += 1;
      // A fresh copy per pull: one 64KB allocation in flight, never all of them.
      controller.enqueue(chunk.slice());
    },
  });
  const stream = json.pipeThrough(new CompressionStream('deflate'));
  const deflated = new Uint8Array(await new Response(stream).arrayBuffer());
  return `https://mermaid.live/edit#pako:${toBase64Url(deflated)}`;
}

/** Build a `#base64:` mermaid.live URL: plain JSON, base64url. */
function base64Url(source) {
  const json = new TextEncoder().encode(JSON.stringify({ code: source }));
  return `https://mermaid.live/edit#base64:${toBase64Url(json)}`;
}

let fetchSpy;
beforeEach(() => {
  // The whole reason this feature is buildable is that the fragment needs no
  // network: nothing in live-url.ts may ever call fetch. Spy here, at the top
  // of every case, so "not fetched" is asserted behaviour, not absence-of-code
  // argument.
  fetchSpy = vi.spyOn(window, 'fetch');
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe('isMermaidLiveUrl', () => {
  it('recognises mermaid.live URLs carrying a pako or base64 fragment', () => {
    expect(isMermaidLiveUrl('https://mermaid.live/edit#pako:abc')).toBe(true);
    expect(isMermaidLiveUrl('https://mermaid.live/edit#base64:abc')).toBe(true);
    // A bare "mermaid.live/edit#…" pasted without the scheme is still the link.
    expect(isMermaidLiveUrl('mermaid.live/edit#pako:abc')).toBe(true);
  });

  it('rejects everything else, loudly by contract', () => {
    // Wrong host: never our lane, and crucially never something we'd fetch.
    expect(isMermaidLiveUrl('https://example.com/edit#pako:abc')).toBe(false);
    // Right host, no diagram fragment.
    expect(isMermaidLiveUrl('https://mermaid.live/edit')).toBe(false);
    expect(isMermaidLiveUrl('https://mermaid.live/edit#other:abc')).toBe(false);
    // Not a URL at all — ordinary diagram source must paste as-is.
    expect(isMermaidLiveUrl('flowchart TD\n  A --> B')).toBe(false);
  });

  it('matches the host by parsing, not by looking for it in the string', () => {
    // A host that merely ENDS with ours, and one that mentions ours in a query:
    // both would pass a substring test, and neither is mermaid.live.
    expect(isMermaidLiveUrl('https://mermaid.live.evil.test/edit#pako:abc')).toBe(false);
    expect(isMermaidLiveUrl('https://evil.test/redir?to=://mermaid.live/edit#pako:abc')).toBe(
      false,
    );
    // Host casing is not significant; the scheme may be absent or http.
    expect(isMermaidLiveUrl('https://MERMAID.LIVE/edit#pako:abc')).toBe(true);
    expect(isMermaidLiveUrl('http://mermaid.live/edit#pako:abc')).toBe(true);
  });

  it('leaves text that merely CONTAINS a live link alone', () => {
    // The paste path keys off this: a diagram or a note that happens to carry a
    // mermaid.live link is ordinary text, and swallowing it would replace the
    // user's whole document with whatever that link decodes to.
    expect(
      isMermaidLiveUrl(
        'flowchart TD\n  A-->B\n  click A href "https://mermaid.live/edit#pako:abc"',
      ),
    ).toBe(false);
    // The '#' here belongs to the Markdown heading, not to the URL — reading
    // the fragment off the raw text rather than off the parsed URL got this
    // wrong, and got it wrong *after* cancelling the paste.
    expect(isMermaidLiveUrl('# Notes\nSee https://mermaid.live/edit#pako:abc')).toBe(false);
  });
});

describe('decodeLiveUrl', () => {
  it('decodes a #pako: fragment (zlib-deflated JSON)', async () => {
    const source = 'flowchart TD\n  A --> B';
    const url = await pakoUrl(source);

    await expect(decodeLiveUrl(url)).resolves.toBe(source);
    // The decode path is decompression, not a fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('decodes a #base64: fragment (plain JSON)', async () => {
    const source = 'sequenceDiagram\n  A->>B: hi';
    const url = base64Url(source);

    await expect(decodeLiveUrl(url)).resolves.toBe(source);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a garbage fragment loudly, without fetching', async () => {
    await expect(decodeLiveUrl('https://mermaid.live/edit#pako:%%%not-base64%%%')).rejects.toThrow(
      /couldn't decode/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a link whose diagram is empty rather than wiping the editor', async () => {
    // mermaid.live will happily share an empty editor. Importing that would
    // silently replace the user's diagram with nothing, so it is an error —
    // the same call the file-drop path makes on an empty .mmd.
    await expect(decodeLiveUrl(base64Url(''))).rejects.toThrow(/no diagram/i);
    await expect(decodeLiveUrl(base64Url('   \n  '))).rejects.toThrow(/no diagram/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a deflate bomb instead of inflating it into the editor', async () => {
    // Repetitive input deflates at roughly 1000:1, so a fragment small enough to
    // paste expands without limit — 64MB here, which is only a fraction of what
    // a ~1MB link could carry. Buffering the whole stream before measuring it
    // would hang or OOM the config iframe; the cap has to bound the work.
    const url = await pakoBombUrl(64 * 1024 * 1024);
    expect(url.length).toBeLessThan(200 * 1024); // small enough to paste

    const err = await decodeLiveUrl(url)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LiveUrlError);
    expect(err.message).toMatch(/too big/i);
    // The size message survives: "too big to import" tells the user something
    // "couldn't decode that link" does not, so it must not be flattened into it.
    expect(err.message).not.toMatch(/couldn't decode/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still imports a large but plausible diagram', async () => {
    // The other side of the cap: it sits far above any diagram written by hand,
    // so raising the ceiling on a bomb must not have lowered it on real work.
    const source = `flowchart TD\n${'  A --> B\n'.repeat(10_000)}`; // ~100KB
    await expect(decodeLiveUrl(await pakoUrl(source))).resolves.toBe(source);
  });

  it('rejects text that merely contains a live link, without decoding part of it', async () => {
    await expect(decodeLiveUrl('# Notes\nSee https://mermaid.live/edit#pako:abc')).rejects.toThrow(
      /not a mermaid live editor url/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-mermaid.live URL without fetching it', async () => {
    await expect(decodeLiveUrl('https://evil.example/diagram.mmd')).rejects.toThrow(
      /not a mermaid live editor url/i,
    );
    // The invariant: a URL is never fetched as a fallback. Rejected, loudly.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tags every deliberate failure as a LiveUrlError', async () => {
    // The editor prints these messages verbatim, and prints nothing else — the
    // class is the contract that lets it tell our copy from an internal error
    // that escaped. Every way this function is designed to fail carries it.
    const failures = [
      'https://evil.example/diagram.mmd', // not our lane
      '# Notes\nSee https://mermaid.live/edit#pako:abc', // link inside other text
      'https://mermaid.live/edit#pako:%%%not-base64%%%', // corrupt payload
      base64Url(''), // decodes fine, carries no diagram
    ];
    for (const input of failures) {
      await expect(decodeLiveUrl(input)).rejects.toBeInstanceOf(LiveUrlError);
    }
  });

  it('keeps the underlying failure as cause, without showing it', async () => {
    // The message is written for the panel; the real atob/inflate/JSON error is
    // still attached for whoever is debugging, just not in front of the user.
    const notJson = toBase64Url(new TextEncoder().encode('this is not JSON'));
    const err = await decodeLiveUrl(`https://mermaid.live/edit#base64:${notJson}`)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LiveUrlError);
    expect(err.message).toMatch(/couldn't decode/i);
    expect(err.cause).toBeInstanceOf(Error);
  });
});
