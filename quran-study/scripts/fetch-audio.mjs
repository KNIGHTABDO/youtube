// Downloads the per-ayah recitation files (plus the basmala) for every candidate surah from EveryAyah.
// Files are cached in audio/ayahs/<folder>/SSSAAA.mp3; re-running only fetches what is missing.
import {mkdirSync, writeFileSync, existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {config, quran, ayahFile, pad3} from './lib.mjs';

const {audioBaseUrl, everyayahFolder, prependBasmala} = config.reciter;
const Q = quran();
const jobs = [];
for (const s of config.surahCandidates) {
  const n = Q.chapters[s - 1].verses;
  for (let a = 1; a <= n; a++) jobs.push([s, a]);
}
if (prependBasmala) jobs.unshift([1, 1]);   // EveryAyah convention: 001001 is played as the basmala before each surah

const todo = jobs.filter(([s, a]) => !existsSync(ayahFile(s, a)) || statSync(ayahFile(s, a)).size < 1024);
mkdirSync(path.dirname(ayahFile(1, 1)), {recursive: true});
console.log(`${everyayahFolder}: ${jobs.length} files needed, ${todo.length} to download`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get([s, a]) {
  const url = `${audioBaseUrl}${everyayahFolder}/${pad3(s)}${pad3(a)}.mp3`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error(`suspiciously small file (${buf.length} bytes)`);
      writeFileSync(ayahFile(s, a), buf);
      return;
    } catch (e) {
      if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
      await sleep(2000 * 2 ** attempt);
    }
  }
}

let done = 0, next = 0;
async function worker() {
  while (next < todo.length) {
    const job = todo[next++];
    await get(job);
    if (++done % 25 === 0 || done === todo.length) console.log(`  ${done}/${todo.length}`);
  }
}
await Promise.all(Array.from({length: 6}, worker));
console.log('Audio ready.');
