#!/usr/bin/env node
// Writes the pinned list of every Piper voice Studio can download (E37): for each voice model in
// rhasspy/piper-voices, its two files with their size and SHA-256 at one fixed revision, its
// speakers, and its license as its model card states it. The app downloads exactly these files
// and checks each against its hash, so a voice is what was pinned here.
//
// Run it again to move to a newer revision; the output is reviewed and committed like any other
// change.
//
//   node scripts/studio-piper-voices.mjs [revision]

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'core', 'src', 'models', 'piperVoices.generated.ts');
const REPO = 'rhasspy/piper-voices';

/** The voices Dev Setup installs as its pack, with the names and genders Studio gave them. */
const PACK = {
  'fa_IR-amir-medium': { label: 'Amir', gender: 'male' },
  'fa_IR-ganji-medium': { label: 'Ganji', gender: 'male' },
  'fa_IR-reza_ibrahim-medium': { label: 'Reza Ibrahim', gender: 'male' },
  'en_US-hfc_female-medium': { label: 'HFC Female', gender: 'female' },
};

/** Parts of a voice's name that are written in capitals or a set way. */
const NAMED = {
  aru: 'ARU',
  arctic: 'ARCTIC',
  bu: 'BU',
  dfki: 'DFKI',
  hfc: 'HFC',
  issai: 'ISSAI',
  kss: 'KSS',
  l2arctic: 'L2-ARCTIC',
  libritts: 'LibriTTS',
  libritts_r: 'LibriTTS-R',
  mls: 'MLS',
  nvcc: 'NVCC',
  tts: 'TTS',
  upc: 'UPC',
  upmc: 'UPMC',
  vctk: 'VCTK',
  vais1000: 'VAIS1000',
};

/** Language names as the rest of Runova writes them. */
const LANGUAGES = { Farsi: 'Persian' };

/** Studio never offers Chinese. */
const LEFT_OUT = /^(zh|cmn|yue)([_-]|$)/;

async function text(url) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) return response.text();
    if (attempt === 4 || response.status === 404) {
      throw new Error(`${url} answered ${response.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
}

/** Runs `work` on every item, a few at a time. */
async function eachLimited(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const at = next++;
        results[at] = await work(items[at]);
      }
    }),
  );
  return results;
}

export function labelFor(name) {
  if (NAMED[name]) return NAMED[name];
  return name
    .split('_')
    .map((part) => NAMED[part] ?? (/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * A model card's license, written one way, and whether it allows commercial use. A license that
 * is not named plainly (a link to the dataset, "See URL", a research licence) counts as
 * non-commercial until someone reads it, which Studio says wherever the voice is offered.
 */
export function licenseFrom(stated) {
  const raw = (stated ?? '').trim();
  const s = raw.toLowerCase();
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/.exec(s);
  let license = null;
  if (cc) license = `CC ${cc[1].toUpperCase()} ${cc[2]}`;
  else if (/^cc0\b/.test(s)) license = 'CC0';
  else if (/public domain/.test(s)) license = 'Public domain';
  else if (/unlicense/.test(s)) license = 'Unlicense';
  else if (s === 'mit') license = 'MIT';
  else if (/apache/.test(s)) license = 'Apache 2.0';
  else if (/^agpl/.test(s)) license = 'AGPL 3.0';
  else if (/^gpl 2/.test(s)) license = 'GPL 2.0';
  else if (/open rail-d/.test(s)) license = 'Open RAIL-D 1.0';
  else if (/^cc[- ]by|^creative commons attribution|^attribution/.test(s)) {
    const nc = /\bnc\b|by-nc|non-?commercial/.test(s);
    const sa = /\bsa\b|-sa\b|sharealike/.test(s);
    const version = /(\d\.\d)/.exec(s)?.[1];
    license = `CC BY${nc ? '-NC' : ''}${sa ? '-SA' : ''}${version ? ` ${version}` : ''}`;
  }
  if (!license) return { license: 'Unknown', nonCommercial: true };
  return { license, nonCommercial: /NC/.test(license) };
}

/** A field from a model card's list, or from the front matter some newer cards start with. */
function cardField(card, field) {
  const listed = new RegExp(`^\\s*\\*\\s*${field}:\\s*(.+)$`, 'im').exec(card ?? '')?.[1];
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(card ?? '')?.[1];
  const fronted = front ? new RegExp(`^${field}:\\s*(.+)$`, 'im').exec(front)?.[1] : undefined;
  return (listed ?? fronted)?.trim() ?? null;
}

async function main() {
  const revision =
    process.argv[2] ??
    JSON.parse(await text(`https://huggingface.co/api/models/${REPO}/revision/main`)).sha;
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`${revision} is not a commit.`);
  const at = `https://huggingface.co/${REPO}/resolve/${revision}`;
  const listed = JSON.parse(await text(`${at}/voices.json`));
  const models = Object.values(listed)
    .filter((m) => !LEFT_OUT.test(m.language.code))
    .sort((a, b) => a.key.localeCompare(b.key));

  const voices = await eachLimited(models, 8, async (model) => {
    const onnxPath = Object.keys(model.files).find((f) => f.endsWith('.onnx'));
    if (!onnxPath) throw new Error(`${model.key} has no model file.`);
    const folder = onnxPath.slice(0, onnxPath.lastIndexOf('/'));
    const tree = JSON.parse(
      await text(`https://huggingface.co/api/models/${REPO}/tree/${revision}/${folder}`),
    );
    const onnx = tree.find((f) => f.path === onnxPath);
    if (!onnx?.lfs?.oid) throw new Error(`${onnxPath} has no SHA-256 in the repository.`);
    const config = await text(`${at}/${folder}/${model.key}.onnx.json`);
    const configBytes = Buffer.from(config, 'utf8');
    const card = Object.keys(model.files).some((f) => f.endsWith('MODEL_CARD'))
      ? await text(`${at}/${folder}/MODEL_CARD`)
      : null;
    const { license, nonCommercial } = licenseFrom(cardField(card, 'License'));
    const source = cardField(card, 'URL');
    const speakers =
      model.num_speakers > 1
        ? Object.entries(model.speaker_id_map)
            .sort((a, b) => a[1] - b[1])
            .map(([name, index], i) => {
              if (index !== i) throw new Error(`${model.key} skips speaker ${i}.`);
              return name;
            })
        : undefined;
    const pack = PACK[model.key];
    return {
      id: model.key,
      folder,
      label: pack?.label ?? labelFor(model.name),
      ...(pack ? { gender: pack.gender, pack: true } : {}),
      locale: model.language.code.replace('_', '-'),
      language: LANGUAGES[model.language.name_english] ?? model.language.name_english,
      quality: model.quality,
      license,
      nonCommercial,
      ...(source && /^https?:\/\//.test(source) ? { source } : {}),
      onnx: [onnx.lfs.size, onnx.lfs.oid],
      config: [configBytes.length, createHash('sha256').update(configBytes).digest('hex')],
      ...(speakers ? { speakers } : {}),
    };
  });

  for (const id of Object.keys(PACK)) {
    if (!voices.some((v) => v.id === id)) throw new Error(`The pack voice ${id} is gone.`);
  }
  const body = `// Written by scripts/studio-piper-voices.mjs; run it again rather than editing this file.

import type { PiperVoiceModel } from './catalog.js';

/** The revision of ${REPO} every Piper voice is pinned to. */
export const PIPER_VOICES_REVISION = '${revision}';

export const PIPER_VOICE_MODELS: readonly PiperVoiceModel[] = ${JSON.stringify(voices)};
`;
  writeFileSync(OUT, body);
  execSync(`pnpm exec biome format --write "${OUT}"`, { cwd: ROOT, stdio: 'inherit' });
  const bytes = voices.reduce((sum, v) => sum + v.onnx[0] + v.config[0], 0);
  const speakers = voices.reduce((sum, v) => sum + (v.speakers?.length ?? 1), 0);
  console.log(
    `${voices.length} voice models, ${speakers} speakers, ${(bytes / 1024 ** 3).toFixed(1)} GB, at ${revision}.`,
  );
  const unknown = voices.filter((v) => v.license === 'Unknown').map((v) => v.id);
  console.log(`License not named plainly, so non-commercial: ${unknown.join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
