#!/usr/bin/env node
// The transport gate from docs/epics/70-mobile-transport-gate.md: the Rust WebRTC stack against a
// real Chromium, with the desktop's own link framing and handshake from packages/protocol running
// as the host. It exercises what a phone does to reach a computer, on this machine's network.
//
//   node apps/mobile/core/interop/chromium.mjs

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const core = resolve(here, '..');
const { chromium } = createRequire(join(repo, 'apps/website/web/package.json'))('playwright-core');
const protocol = await import(`file://${join(repo, 'packages/protocol/dist/index.js')}`);

const fail = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};
setTimeout(() => fail('timed out after 90 s'), 90_000).unref();

const hostIdentity = protocol.identityFromSeed(new Uint8Array(32).fill(0x11));
const controllerIdentity = protocol.identityFromSeed(new Uint8Array(32).fill(0x22));
const hex = Buffer.from(hostIdentity.publicKey).toString('hex');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const rust = spawn(
  'cargo',
  ['run', '--quiet', '-p', 'runova-rtc', '--example', 'secure_controller', '--', hex],
  {
    cwd: core,
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  },
);
rust.on('exit', (code) => {
  if (code !== 0 && code !== null) fail(`the Rust peer exited with ${code}`);
});

let hostKeys = null;
let rustSafetyCode = null;
let fingerprints = null;
let handshake = null;
const reassembler = new protocol.LinkReassembler();
let nextId = 1;
const pending = [];

async function sendMessage(kind, payload) {
  for (const frame of protocol.encodeLinkMessage(kind, payload, nextId++)) {
    await page.evaluate((b64) => window.sendFrame(b64), Buffer.from(frame).toString('base64'));
  }
}
const sendJson = (value) =>
  sendMessage(protocol.LINK_TEXT, Buffer.from(JSON.stringify(value), 'utf8'));

async function onMessage(message) {
  if (!hostKeys) {
    const value = JSON.parse(Buffer.from(message.payload).toString('utf8'));
    if (value.t === 'hs-hello') {
      await sendJson(handshake.respond(value));
    } else if (value.t === 'hs-finish') {
      hostKeys = handshake.complete(value);
      console.log(`host: handshake complete, safety code ${hostKeys.safetyCode}`);
    } else {
      fail(`unexpected handshake message ${value.t}`);
    }
    return;
  }
  if (message.kind === protocol.LINK_TEXT) {
    const text = Buffer.from(message.payload).toString('utf8');
    console.log(`host: heard "${text}"`);
    await sendMessage(protocol.LINK_TEXT, Buffer.from(`pong:${text}`, 'utf8'));
  } else {
    console.log(`host: echoing ${message.payload.length} bytes`);
    await sendMessage(protocol.LINK_BINARY, message.payload);
  }
}

let chain = Promise.resolve();
const enqueue = (frame) => {
  chain = chain
    .then(async () => {
      const message = reassembler.push(frame);
      if (message) await onMessage(message);
    })
    .catch((error) => fail(`host: ${error.stack ?? error}`));
};

await page.exposeFunction('deliverSignal', (json) => rust.stdin.write(`${json}\n`));
await page.exposeFunction('channelOpen', (local, remote, label, ordered) => {
  console.log(`chromium: channel "${label}" open, ordered=${ordered}`);
  fingerprints = { local, remote };
  handshake = protocol.hostHandshake({
    sessionId: 'interop',
    mode: 'ask',
    identity: hostIdentity,
    expectedControllerKey: controllerIdentity.publicKey,
    localFingerprint: local,
    remoteFingerprint: remote,
  });
  for (const frame of pending.splice(0)) enqueue(frame);
});
await page.exposeFunction('frameIn', (b64) => {
  const frame = new Uint8Array(Buffer.from(b64, 'base64'));
  if (handshake) enqueue(frame);
  else pending.push(frame);
});

// The same steps as apps/desktop/src/renderer/src/lib/anywhere/linkPeer.ts on the host's side.
await page.evaluate(() => {
  const fingerprintOf = (sdp) => {
    const match = /a=fingerprint:(\S+) (\S+)/i.exec(sdp ?? '');
    return match ? `${match[1].toLowerCase()} ${match[2].toUpperCase()}` : '';
  };
  const pc = new RTCPeerConnection({ iceServers: [] });
  let channel = null;
  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    const c = event.candidate.toJSON();
    window.deliverSignal(
      JSON.stringify({
        k: 'ice',
        candidate: c.candidate ?? '',
        sdpMid: c.sdpMid ?? null,
        sdpMLineIndex: c.sdpMLineIndex ?? null,
      }),
    );
  };
  pc.ondatachannel = (event) => {
    channel = event.channel;
    channel.binaryType = 'arraybuffer';
    const opened = () =>
      window.channelOpen(
        fingerprintOf(pc.localDescription?.sdp),
        fingerprintOf(pc.remoteDescription?.sdp),
        channel.label,
        channel.ordered,
      );
    if (channel.readyState === 'open') opened();
    else channel.onopen = opened;
    channel.onmessage = (message) => {
      let text = '';
      for (const byte of new Uint8Array(message.data)) text += String.fromCharCode(byte);
      window.frameIn(btoa(text));
    };
  };
  window.sendFrame = (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    channel.send(bytes);
  };
  window.onOffer = async (sdp) => {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    window.deliverSignal(JSON.stringify({ k: 'sdp', type: 'answer', sdp: answer.sdp ?? '' }));
  };
});

const lines = createInterface({ input: rust.stdout });
lines.on('line', async (line) => {
  if (line.startsWith('SIGNAL ')) {
    const signal = JSON.parse(line.slice(7));
    if (signal.k === 'sdp' && signal.type === 'offer') {
      await page.evaluate((sdp) => window.onOffer(sdp), signal.sdp);
    }
  } else if (line.startsWith('OPEN ')) {
    console.log(`rust: channel open, fingerprint ${line.slice(5, 40)}...`);
  } else if (line.startsWith('SECURE ')) {
    rustSafetyCode = line.slice(7);
    console.log(`rust: handshake complete, safety code ${rustSafetyCode}`);
  } else if (line === 'DONE') {
    if (!hostKeys) fail('the Rust peer finished before the host did');
    if (rustSafetyCode !== hostKeys.safetyCode) fail('the safety codes differ');
    if (!fingerprints?.local || !fingerprints?.remote) fail('a fingerprint was missing');
    console.log('PASS Rust and real Chromium opened runova-link and completed the handshake');
    await browser.close();
    process.exit(0);
  } else {
    console.log(`rust: ${line}`);
  }
});
