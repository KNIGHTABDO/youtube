// Measures every ayah by decoding it, picks the surahs that fit the session, and writes:
//   film/timeline.js            timings + verse text the film reads (window.STUDY)
//   out/audio.m4a               the full-length soundtrack, aligned to the video (intro silence included)
//   out/youtube-chapters.txt    chapter list for the description
//   out/youtube-description.txt ready-to-paste description with credits
// --mock estimates durations from the text instead of reading audio (for previews without downloads).
import {mkdirSync, writeFileSync, rmSync, openSync, writeSync, closeSync, readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {config, quran, FILM, OUT, AUDIO, FFMPEG, run, ayahFile, stamp} from './lib.mjs';

const MOCK = process.argv.includes('--mock');
const RATE = 44100;                                   // mono PCM while assembling; exact sample counts keep text and voice in sync
const Q = quran();
const BASMALA = Q.verses['1'][0];
const {prependBasmala} = config.reciter;
const intro = config.introSeconds, outro = config.outroSeconds, session = config.sessionMinutes * 60;
const cache = path.join(AUDIO, 'pcm');
mkdirSync(OUT, {recursive: true});

// ---- 1. durations ----
const letters = t => (t.match(/[ء-يٱ]/g) || []).length;
async function measure(s, a) {
  if (MOCK) return {sec: 1.5 + .30 * letters(Q.verses[s][a - 1])};   // ~Minshawi murattal pace
  const file = ayahFile(s, a);
  if (!existsSync(file)) throw new Error(`Missing ${file}. Run: npm run audio`);
  const pcm = path.join(cache, path.basename(file, '.mp3') + '.raw');
  if (!existsSync(pcm)) {
    mkdirSync(cache, {recursive: true});
    await run(FFMPEG, ['-v', 'error', '-y', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 's16le', pcm]);
  }
  const samples = readFileSync(pcm).length / 2;
  return {sec: samples / RATE, pcm, samples};
}

const surahParts = [];
let basmalaPart = null;
if (prependBasmala) basmalaPart = await measure(1, 1);
for (const s of config.surahCandidates) {
  const ch = Q.chapters[s - 1], parts = [];
  if (prependBasmala && s !== 1 && s !== 9) parts.push({a: 0, ...basmalaPart});
  for (let a = 1; a <= ch.verses; a++) parts.push({a, ...await measure(s, a)});
  surahParts.push({s, ch, parts, sec: parts.reduce((t, p) => t + p.sec, 0)});
  process.stdout.write(`  measured ${s} ${ch.translit} (${(surahParts.at(-1).sec / 60).toFixed(1)} min)\n`);
}

// If a reciter's ayah-1 files already contain the basmala it would be heard twice: a short first ayah that lasts
// longer than the basmala itself is the tell-tale sign.
if (prependBasmala && !MOCK) for (const sp of surahParts) {
  const a1 = sp.parts.find(p => p.a === 1), txt = Q.verses[sp.s][0].replace(BASMALA + ' ', '');
  if (sp.s !== 1 && sp.s !== 9 && letters(txt) < 14 && a1.sec > basmalaPart.sec + 1.5)
    console.warn(`  ! ${sp.ch.translit} ayah 1 lasts ${a1.sec.toFixed(1)} s (basmala alone ${basmalaPart.sec.toFixed(1)} s): it may already include the basmala. Listen to a clip; if you hear it twice set reciter.prependBasmala to false.`);
}

// ---- 2. fit the session: keep mushaf order, take each surah that still fits ----
const gap = config.gapBetweenSurahsSeconds, limit = session - 12;
const chosen = [];
let used = 0;
for (const sp of surahParts) {
  const need = (chosen.length ? gap : 0) + sp.sec;
  if (used + need <= limit) { chosen.push(sp); used += need; }
}
if (!chosen.length) throw new Error('No surah fits the session length');

// ---- 3. timeline in video seconds ----
const segs = [], surahs = [];
let t = intro;
chosen.forEach((sp, k) => {
  if (k) t += gap;
  const t0 = t;
  for (const p of sp.parts) {
    let text = p.a === 0 ? BASMALA : Q.verses[sp.s][p.a - 1];
    // Tanzil writes the basmala at the start of ayah 1; when it is recited separately it is shown separately.
    if (p.a === 1 && prependBasmala && sp.s !== 1 && sp.s !== 9 && text.startsWith(BASMALA + ' ')) text = text.slice(BASMALA.length + 1);
    segs.push({t0: +t.toFixed(3), t1: +(t + p.sec).toFixed(3), s: sp.s, a: p.a, text});
    t += p.sec;
  }
  surahs.push({id: sp.s, name: sp.ch.name, translit: config.surahNames?.[sp.s] || sp.ch.translit, translation: sp.ch.translation, verses: sp.ch.verses, t0: +t0.toFixed(3), t1: +t.toFixed(3)});
});
const recitationEnd = t, total = intro + session + outro;
const phases = [];
for (let p = 0, tt = intro, n = 1; tt < intro + session - 1e-6; p++) {
  const kind = p % 2 ? 'break' : 'focus', dur = Math.min((kind === 'focus' ? config.pomodoro.focusMinutes : config.pomodoro.breakMinutes) * 60, intro + session - tt);
  phases.push({kind, n, t0: tt, t1: tt + dur}); tt += dur; if (kind === 'break') n++;
}

const opening = {s: 73, a: 4, text: Q.verses['73'][3]};   // وَرَتِّلِ ٱلْقُرْءَانَ تَرْتِيلًا, shown on the title card
const STUDY = {
  mock: MOCK, opening, channel: config.channel, reciter: config.reciter.name, reciterArabic: config.reciter.nameArabic, style: config.reciter.style,
  intro, outro, session, total, recitationEnd: +recitationEnd.toFixed(3), phases, surahs, segs,
};
writeFileSync(path.join(FILM, 'timeline.js'), `// generated by scripts/build-timeline.mjs${MOCK ? ' (MOCK timings: estimated, no audio)' : ''}\nwindow.STUDY = ${JSON.stringify(STUDY)};\n`);

// ---- 4. soundtrack ----
if (!MOCK) {
  const raw = path.join(OUT, 'recitation.raw'), fd = openSync(raw, 'w');
  const silence = sec => { let n = Math.round(sec * RATE) * 2; const z = Buffer.alloc(Math.min(n, 1 << 20)); while (n > 0) { const k = Math.min(n, z.length); writeSync(fd, z, 0, k); n -= k; } };
  let written = 0;   // in samples, to keep the assembled track on the exact timeline
  const pushSilenceTo = sec => { const target = Math.round(sec * RATE); if (target > written) { silence((target - written) / RATE); written = target; } };
  for (const seg of segs) {
    pushSilenceTo(seg.t0);
    const part = seg.a === 0 ? basmalaPart : {pcm: path.join(cache, `${String(seg.s).padStart(3, '0')}${String(seg.a).padStart(3, '0')}.raw`)};
    const buf = readFileSync(part.pcm); writeSync(fd, buf); written += buf.length / 2;
  }
  pushSilenceTo(total); closeSync(fd);
  console.log('Encoding soundtrack (loudness-normalised AAC)...');
  await run(FFMPEG, ['-v', 'error', '-y', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', raw,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000', '-ac', '2', '-c:a', 'aac', '-b:a', config.video.audioBitrate, '-t', String(total), path.join(OUT, 'audio.m4a')]);
  rmSync(raw);
}

// ---- 5. YouTube text ----
const chapters = [`0:00 Intro`];
surahs.forEach(s => chapters.push(`${stamp(s.t0)} Surah ${s.translit} (${s.name})`));
if (recitationEnd < intro + session - 15) chapters.push(`${stamp(recitationEnd + 1)} Quiet study`);
chapters.push(`${stamp(intro + session)} Session complete`);
writeFileSync(path.join(OUT, 'youtube-chapters.txt'), chapters.join('\n') + '\n');
const list = surahs.map(s => `Surah ${s.translit} (${s.name})`).join(', ');
const desc = `Study with me for 1 hour with the calm Qur'an recitation of Sheikh ${config.reciter.name} (${config.reciter.style}).
Two Pomodoro sessions (25 min focus / 5 min break), a hand-drawn night study desk, and the Arabic text of every ayah shown as it is recited.

Recited: ${list}.

⏱️ Chapters
${chapters.join('\n')}

📖 Credits
• Recitation: Sheikh ${config.reciter.name} — ${config.reciter.style} (audio via EveryAyah.com)
• Qur'an text: Tanzil Project — https://tanzil.net (Uthmani text, used verbatim, CC BY 3.0)
• Arabic font: Amiri Quran by Khaled Hosny (SIL Open Font License)
• Animation: hand-drawn Canvas 2D (hand-drawn-canvas-animation skill, MIT)

May Allah put barakah in your time and make your studies easy for you. 🤲
Subscribe for more calm study sessions: ${config.channel}

#studywithme #quran #pomodoro #${config.reciter.name.split(' ').at(-1).replace(/[^A-Za-z]/g, '').toLowerCase()} #quranrecitation #studywithquran #studymotivation
`;
writeFileSync(path.join(OUT, 'youtube-description.txt'), desc);
const names = surahs.slice(0, 4).map(s => s.translit).join(', ');
writeFileSync(path.join(OUT, 'youtube-title-ideas.txt'), [
  `1 Hour Study With Me 📖 Calm Quran Recitation | Pomodoro 25/5 | Sheikh ${config.reciter.name.split(' ').at(-1)}`,
  `Study With Quran 🌙 1 Hour Pomodoro (25/5) | ${names}`,
  `Calm Quran for Studying — 1 Hour Study With Me (Pomodoro 25/5) | ${config.reciter.name}`,
  `Night Study With Me 🕯️ 1 Hour Quran Recitation + Pomodoro Timer (25/5)`,
].join('\n') + '\n');

console.log(`\n${surahs.length} surahs, ${segs.length} segments, recitation ${stamp(recitationEnd - intro)} of ${stamp(session)} session; video ${stamp(total)}${MOCK ? ' [MOCK]' : ''}`);
surahs.forEach(s => console.log(`  ${stamp(s.t0)}  ${s.id} ${s.translit} (${s.verses} ayahs)`));
