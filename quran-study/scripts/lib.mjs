// Shared paths and helpers for the build scripts.
import {readFileSync, existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILM = path.join(ROOT, 'film');
export const AUDIO = path.join(ROOT, 'audio');
export const OUT = path.join(ROOT, 'out');
export const config = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
export const quran = () => JSON.parse(readFileSync(path.join(FILM, 'data', 'quran-uthmani.json'), 'utf8'));

// A system ffmpeg wins when FFMPEG is set; otherwise the static build from npm.
export const FFMPEG = process.env.FFMPEG || require('ffmpeg-static');
export const FFPROBE = process.env.FFPROBE || require('ffprobe-static').path;

export const pad3 = n => String(n).padStart(3, '0');
export const ayahFile = (s, a) => path.join(AUDIO, 'ayahs', config.reciter.everyayahFolder, `${pad3(s)}${pad3(a)}.mp3`);
export const hasAyah = (s, a) => existsSync(ayahFile(s, a));

// Run a process; resolve with stdout (Buffer) or reject with stderr.
export function run(cmd, args, {input} = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe']});
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${Buffer.concat(err).toString().slice(-2000)}`)));
    if (input) p.stdin.end(input);
  });
}

// mm:ss or h:mm:ss, as YouTube chapters want it.
export function stamp(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
}
