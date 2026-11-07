/**
 * Local stream proxy: how the renderer's <audio> element gets at the library.
 * This tiny HTTP server on 127.0.0.1 answers with a local file or pipes a
 * server's response back (with Range requests for seeking), so the server's
 * token stays in the main process and the renderer needs no way to file://.
 */
import fs from "fs";
import http from "http";
import path from "path";
import type { AddressInfo } from "net";
import { fetchStream as fetchJellyfinStream } from "./jellyfin";
import { fetchStream as fetchSubsonicStream } from "./subsonic";
import { localStreamPath } from "./local-library";
import { servedPathFor } from "./transcode";

const PASSTHROUGH_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"];

let server: http.Server | null = null;
let proxyPort = 0;

/**
 * Origin gate. The proxy is app infrastructure on a loopback port, but any
 * local process — or a hostile website via its browser's localhost exemption —
 * can reach it. With `Access-Control-Allow-Origin: *` such a caller could
 * read streamed bytes. The renderer itself never needs CORS for playback
 * (the media element sends no Origin and <audio> without crossOrigin ignores
 * CORS), and its fetch()es come from the packaged file:// origin ("null") or
 * the dev server. Any real Origin outside the dev servers is refused before
 * a single byte is resolved.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  // Host must be the loopback authority this server serves — kills DNS
  // rebinding by hostname.
  if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return false;
  if (!origin) return true; // media element / non-CORS clients
  if (origin === "null") return true; // packaged renderer fetch (file:// origin)
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin); // dev renderer
}

export function startStreamProxy(): Promise<number> {
  if (proxyPort) return Promise.resolve(proxyPort);
  server = http.createServer((req, res) => {
    if (!originAllowed(req.headers.origin as string | undefined, req.headers.host as string | undefined)) {
      res.writeHead(403);
      res.end();
      return;
    }
    void handle(req, res);
  });
  // Keep idle sockets alive; media elements reuse connections while seeking.
  server.keepAliveTimeout = 65_000;
  return new Promise<number>((resolve, reject) => {
    server!.on("error", reject);
    server!.listen(0, "127.0.0.1", () => {
      proxyPort = (server!.address() as AddressInfo).port;
      console.log(`[bytune] stream proxy on 127.0.0.1:${proxyPort}`);
      resolve(proxyPort);
    });
  });
}

/* Local library files travel through the proxy too: the renderer runs on an
 * http origin (dev server / packaged build), and Chromium refuses to load
 * file:// media from a non-file origin. The route only ever serves files the
 * scanner indexed (looked up by id in the local library), so it's exactly as
 * trusted as the IPC channel itself and can't become a path relay. */
export function proxyUrlForLocalTrack(localId: string): string | null {
  if (!proxyPort) return null;
  return `http://127.0.0.1:${proxyPort}/?lid=${encodeURIComponent(localId)}`;
}

/* Jellyfin items stream through the proxy as well: the main process holds
 * the server token (it never reaches the renderer), and plain-http LAN
 * servers play without opening the renderer's CSP to arbitrary hosts. */
export function proxyUrlForJellyfin(trackId: string): string | null {
  if (!proxyPort) return null;
  const itemId = trackId.replace(/^jf:/, "");
  return `http://127.0.0.1:${proxyPort}/?jf=${encodeURIComponent(itemId)}`;
}

/* Navidrome/Subsonic songs take the same route as Jellyfin items. */
export function proxyUrlForSubsonic(trackId: string): string | null {
  if (!proxyPort) return null;
  return `http://127.0.0.1:${proxyPort}/?ss=${encodeURIComponent(trackId.replace(/^ss:/, ""))}`;
}

const LOCAL_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".wma": "audio/x-ms-wma",
};

function serveLocalFile(id: string, range: string | undefined, res: http.ServerResponse, req: http.IncomingMessage): void {
  // Formats Chromium can't decode are served from their converted FLAC.
  const original = localStreamPath(id);
  const filePath = original ? servedPathFor(original) : null;
  if (!filePath) {
    res.writeHead(404);
    res.end("local file missing");
    return;
  }
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    res.writeHead(404);
    res.end("local file missing");
    return;
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "Content-Type": LOCAL_MIME[path.extname(filePath).toLowerCase()] ?? "audio/mpeg",
  };

  // Range support is what makes seeking work: the media element re-requests
  // the byte span it jumped to, we answer 206 with exactly that slice.
  let start = 0;
  let end = size - 1;
  let status = 200;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] !== "" || match[2] !== "")) {
    if (match[1] === "") {
      const suffix = Math.min(parseInt(match[2], 10), size);
      start = size - suffix;
      end = size - 1;
    } else {
      start = parseInt(match[1], 10);
      end = match[2] === "" ? size - 1 : Math.min(parseInt(match[2], 10), size - 1);
    }
    if (Number.isNaN(start) || start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  res.writeHead(status, headers);

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", (err) => {
    // Basename only — the log must not carry the user's folder structure.
    console.warn(`[bytune] local file read error (${path.basename(filePath)}):`, err instanceof Error ? err.message : err);
    res.destroy();
  });
  req.on("close", () => stream.destroy());
  stream.pipe(res);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const localId = url.searchParams.get("lid");
    const jellyfinId = url.searchParams.get("jf");
    const subsonicId = url.searchParams.get("ss");
    if (!localId && !jellyfinId && !subsonicId) {
      res.writeHead(400);
      res.end("missing id");
      return;
    }
    const range = req.headers.range;
    if (localId) {
      serveLocalFile(localId, range, res, req);
      return;
    }
    if (jellyfinId) {
      await pipeUpstream(await fetchJellyfinStream(jellyfinId, range), `jf:${jellyfinId}`, req, res);
      return;
    }
    await pipeUpstream(await fetchSubsonicStream(subsonicId as string, range), `ss:${subsonicId}`, req, res);
  } catch (err) {
    console.warn("[bytune] proxy error:", err instanceof Error ? err.message : err);
    try {
      res.writeHead(502);
      res.end("proxy error");
    } catch {
      /* response already gone */
    }
  }
}

/** Relay an upstream audio response (status, range headers, body) to the media element. */
async function pipeUpstream(
  upstream: Response,
  label: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!upstream.ok || !upstream.body) {
    console.warn(`[bytune] proxy upstream HTTP ${upstream.status} for ${label}`);
    res.writeHead(upstream.status === 403 ? 404 : upstream.status);
    res.end();
    return;
  }

  const outHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  for (const h of PASSTHROUGH_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  res.writeHead(upstream.status, outHeaders);

  const reader = upstream.body.getReader();
  req.on("close", () => {
    void reader.cancel().catch(() => undefined);
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0 && !res.write(value)) {
      await new Promise<void>((resolve) => res.once("drain", () => resolve()));
    }
  }
  res.end();
}
