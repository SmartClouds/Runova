// Stands in for Sentry and an OpenTelemetry collector in the test stack (compose.test.yaml). It
// answers every request with 200 and appends what came in, decompressed, to one file, so the
// secrets spec can read it back with `docker compose exec` and look for values that must not be
// there. Sentry envelopes arrive at /api/<project>/envelope/, OTLP at /v1/traces, /v1/logs and
// /v1/metrics. Protobuf keeps strings as plain UTF-8, so a text search finds them.
import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export const SINK_PORT = 4318;
export const SINK_FILE = '/tmp/telemetry.ndjson';
/**
 * The file starts over once it is this big. Every Information log is a Sentry event of about 45 KB
 * and the health checks log all the time, so a stack left running would otherwise fill the disk.
 * The secrets spec empties the file when it starts and writes far less than this.
 */
export const SINK_LIMIT = 128 * 1024 * 1024;

/** One request the sink received. `body` is base64, after any Content-Encoding is undone. */
export interface Capture {
  path: string;
  body: string;
}

function decode(raw: Buffer, encoding: string | undefined): Buffer {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
      return gunzipSync(raw);
    case 'deflate':
      return inflateSync(raw);
    case 'br':
      return brotliDecompressSync(raw);
    default:
      return raw;
  }
}

if (import.meta.main) {
  appendFileSync(SINK_FILE, '');
  createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://sink').pathname;
    if (path === '/health') {
      response.end('ok');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = decode(Buffer.concat(chunks), request.headers['content-encoding']);
    const capture: Capture = { path, body: body.toString('base64') };
    if ((statSync(SINK_FILE, { throwIfNoEntry: false })?.size ?? 0) > SINK_LIMIT) {
      writeFileSync(SINK_FILE, '');
    }
    appendFileSync(SINK_FILE, `${JSON.stringify(capture)}\n`);
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  }).listen(SINK_PORT);
}
