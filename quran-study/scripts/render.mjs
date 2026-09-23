// Renders the film to MP4 with headless Chrome: frames stream as JPEG straight into ffmpeg (no PNG folders),
// several browsers work on separate chunks in parallel, and finished chunks are kept so an interrupted render resumes.
//   node scripts/render.mjs                    full video -> out/quran-study-with-me.mp4
//   node scripts/render.mjs --preview          stills at key moments + contact sheet -> out/preview/
//   node scripts/render.mjs --clip 0,45        a short clip (with audio if built) -> out/preview/clip-0.mp4
//   node scripts/render.mjs --thumb            YouTube thumbnail -> out/thumbnail.jpg
// Options: --workers N (default: half the CPU threads, max 6), --width 1920|2560|3840, --fresh (discard finished chunks)
import puppeteer from 'puppeteer';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createReadStream, existsSync, mkdirSync, readdirSync, rmSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {FILM, OUT, FFMPEG, config, run, stamp} from './lib.mjs';

const argv = process.argv.slice(2), has = f => argv.includes(f), val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const WIDTH = +(val('--width') || config.video.width), FPS_OUT = 24;
const WORKERS = Math.max(1, +(val('--workers') || Math.min(6, Math.max(1, Math.floor(os.cpus().length / 2)))));
const NAME = 'quran-study-with-me';
if (!existsSync(path.join(FILM, 'timeline.js'))) throw new Error('film/timeline.js missing: run `npm run timeline` (or `node scripts/build-timeline.mjs --mock`)');

// ---- a tiny static server: Chrome will not load fonts from file:// pages ----
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2'};
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/favicon')) { res.writeHead(204); return res.end(); }
  const p = path.join(FILM, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(FILM) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream'}); createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/study.html`;

const launchOpts = {headless: true, executablePath: process.env.CHROME || undefined,
  args: ['--disable-dev-shm-usage', '--font-render-hinting=none', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]};
async function openFilm(query = '') {
  const browser = await puppeteer.launch(launchOpts), page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location()?.url || ''}`); });
  await page.goto(`${BASE}?bare=1&w=${WIDTH}${query}`, {waitUntil: 'load'});
  await page.waitForFunction('window.__ready === true || window.__error', {timeout: 120000});
  const meta = await page.evaluate(() => ({N: window.__NDRAW, fps: window.__fps, size: window.__size, error: window.__error}));
  if (meta.error || errors.length) throw new Error(meta.error || errors.join('\n'));
  return {browser, page, errors, ...meta};
}
const jpeg = async (page, i, q = .93) => Buffer.from((await page.evaluate((i, q) => window.__jpeg(i, q), i, q)).split(',')[1], 'base64');

// frames -> ffmpeg (each 12 fps drawing is written twice for an exact 24 fps stream)
function encoder(file, extra = []) {
  const {crf, preset} = config.video;
  const p = spawn(FFMPEG, ['-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS_OUT), '-i', '-',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-tune', 'animation', '-pix_fmt', 'yuv420p', '-g', '96', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', ...extra, file], {stdio: ['pipe', 'ignore', 'inherit']});
  const done = new Promise((res, rej) => { p.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code} for ${file}`))); p.on('error', rej); });
  const write = buf => new Promise(res => p.stdin.write(buf) ? res() : p.stdin.once('drain', res));
  return {write, end: async () => { p.stdin.end(); await done; }};
}

try {
  if (has('--thumb')) {
    const {browser, page} = await openFilm('&thumb=1');
    const tmp = path.join(OUT, 'thumbnail-full.jpg'); mkdirSync(OUT, {recursive: true}); writeFileSync(tmp, await jpeg(page, 0, .96)); await browser.close();
    await run(FFMPEG, ['-v', 'error', '-y', '-i', tmp, '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '2', path.join(OUT, 'thumbnail.jpg')]); rmSync(tmp);
    console.log('Thumbnail: out/thumbnail.jpg (1280x720)');
  } else if (has('--preview')) {
    const dir = path.join(OUT, 'preview'); mkdirSync(dir, {recursive: true});
    for (const f of readdirSync(dir)) if (/^t\d+\.jpg$/.test(f)) rmSync(path.join(dir, f));
    const {browser, page, N, fps} = await openFilm();
    const ST = await page.evaluate(() => window.STUDY);
    const times = (val('--at') || '').split(',').filter(Boolean).map(Number);
    if (!times.length) {
      times.push(.5, 2, 3.5, 5, 6.5, ST.intro - .2);                                       // the intro drawing itself on
      for (const s of ST.surahs) times.push(s.t0 + .9, s.t0 + 30);                           // each surah header and an ayah in it
      times.push(ST.phases[0].t1 + 1.5, ST.phases[1].t1 + 10, ST.recitationEnd + 5, ST.total - 8);
    }
    for (const t of times) { const i = Math.min(N - 1, Math.round(t * fps)); writeFileSync(path.join(dir, `t${String(Math.round(t * 10)).padStart(6, '0')}.jpg`), await jpeg(page, i)); }
    await browser.close();
    await run(FFMPEG, ['-v', 'error', '-y', '-pattern_type', 'glob', '-i', path.join(dir, 't*.jpg'), '-vf', 'scale=480:-2,tile=4x' + Math.ceil(times.length / 4), '-frames:v', '1', path.join(dir, 'contact.jpg')]);
    console.log(`Preview: ${times.length} stills + contact sheet in out/preview/`);
  } else if (val('--clip')) {
    const [a, d] = val('--clip').split(',').map(Number), dir = path.join(OUT, 'preview'); mkdirSync(dir, {recursive: true});
    const {browser, page, N, fps} = await openFilm(), i0 = Math.round(a * fps), i1 = Math.min(N, Math.round((a + d) * fps));
    const tmp = path.join(dir, `clip-${a}.video.mp4`), enc = encoder(tmp);
    for (let i = i0; i < i1; i++) { const f = await jpeg(page, i); await enc.write(f); await enc.write(f); }
    await enc.end(); await browser.close();
    const out = path.join(dir, `clip-${a}.mp4`), audio = path.join(OUT, 'audio.m4a');
    if (existsSync(audio)) await run(FFMPEG, ['-v', 'error', '-y', '-i', tmp, '-ss', String(a), '-t', String(d), '-i', audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', out]); else renameSync(tmp, out);
    rmSync(tmp, {force: true}); console.log(`Clip: ${path.relative(process.cwd(), out)}${existsSync(audio) ? '' : ' (no audio yet: run npm run audio && npm run timeline)'}`);
  } else {
    // ---- full render ----
    const audio = path.join(OUT, 'audio.m4a');
    if (!existsSync(audio)) throw new Error('out/audio.m4a missing: run `npm run audio` then `npm run timeline` first');
    const probe = await openFilm(); const {N, fps} = probe; const ST = await probe.page.evaluate(() => window.STUDY); await probe.browser.close();
    if (ST.mock) throw new Error('film/timeline.js holds MOCK timings; run `npm run timeline` after `npm run audio`');
    const segDir = path.join(OUT, `.segments-${WIDTH}`); if (has('--fresh')) rmSync(segDir, {recursive: true, force: true}); mkdirSync(segDir, {recursive: true});
    const CHUNK = 1440, chunks = [];   // 2 minutes of video per chunk
    for (let a = 0, k = 0; a < N; a += CHUNK, k++) chunks.push({k, a, b: Math.min(N, a + CHUNK), file: path.join(segDir, `seg-${String(k).padStart(4, '0')}.mp4`)});
    const todo = chunks.filter(c => !existsSync(c.file + '.done'));
    console.log(`${NAME}: ${N} drawings @${fps} fps -> ${stamp(N / fps)} at ${WIDTH}px; ${chunks.length} chunks, ${todo.length} to render with ${WORKERS} workers`);
    const t0 = Date.now(); let rendered = 0; const totalTodo = todo.reduce((s, c) => s + c.b - c.a, 0);
    const progress = setInterval(() => { const el = (Date.now() - t0) / 1000, r = rendered / el; if (r > 0) console.log(`  ${rendered}/${totalTodo} drawings  ${r.toFixed(1)}/s  ETA ${stamp((totalTodo - rendered) / r)}`); }, 30000);
    let next = 0;
    await Promise.all(Array.from({length: Math.min(WORKERS, todo.length)}, async () => {
      const {browser, page, errors} = await openFilm();
      try {
        while (next < todo.length) {
          const c = todo[next++], tmp = c.file.replace('.mp4', '.part.mp4'), enc = encoder(tmp, ['-f', 'mp4']);
          for (let i = c.a; i < c.b; i++) { const f = await jpeg(page, i); await enc.write(f); await enc.write(f); rendered++; if (errors.length) throw new Error(`frame ${i}: ${errors.join('\n')}`); }
          await enc.end(); renameSync(tmp, c.file); writeFileSync(c.file + '.done', '');
        }
      } finally { await browser.close(); }
    }));
    clearInterval(progress);
    const list = path.join(segDir, 'list.txt'); writeFileSync(list, chunks.map(c => `file '${c.file.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const out = path.join(OUT, `${NAME}.mp4`);
    console.log('Joining chunks and muxing the recitation...');
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-t', String(N / fps), '-movflags', '+faststart', out]);
    console.log(`Done in ${stamp((Date.now() - t0) / 1000)}: out/${NAME}.mp4 (${(statSync(out).size / 1e9).toFixed(2)} GB). Chunks kept in ${path.relative(process.cwd(), segDir)} until you delete them.`);
  }
} finally { server.close(); }
