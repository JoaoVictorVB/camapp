'use strict';
/*
 * CamApp — servidor local da camera IP
 * Node >= 18, zero dependencias. Usa ffmpeg para falar RTSP.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const REC_DIR = path.join(ROOT, 'recordings');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const PORT = CFG.port || 8080;
const RTSP = CFG.rtsp;
const FFMPEG = path.isAbsolute(CFG.ffmpeg) ? CFG.ffmpeg : path.join(ROOT, CFG.ffmpeg);
const FPS = CFG.streamFps || 12;
const CAMERA_NAME = CFG.cameraName || 'Camera';

fs.mkdirSync(REC_DIR, { recursive: true });

/* ---------------------------------------------------------------- utils */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function send(res, code, body, headers = {}) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers);
  res.writeHead(code, h);
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function hostPortOf(rtspUrl) {
  const u = new URL(rtspUrl);
  return { host: u.hostname, port: Number(u.port) || 554 };
}

function cameraOnline() {
  const { host, port } = hostPortOf(RTSP);
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { try { s.destroy(); } catch (_) {} resolve(ok); };
    s.setTimeout(1500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------- gravacao */

let rec = null; // { proc, file, started, finalizing }

/* .ts sobrevive a encerramento abrupto (Windows nao entrega SIGINT ao filho).
   Ao parar, remuxa o ts pra mp4 (rapido, stream copy). */
function finalizeTs(tsFile) {
  const mp4File = tsFile.replace(/\.ts$/i, '.mp4');
  const proc = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-i', tsFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', mp4File
  ], { windowsHide: true });
  let errLog = '';
  proc.stderr.on('data', (d) => { errLog += d.toString(); });
  proc.on('error', (e) => console.error('[rec] remux spawn:', e.message));
  proc.on('exit', (code) => {
    let ok = false;
    try { ok = code === 0 && fs.existsSync(mp4File); } catch (_) {}
    if (ok) {
      const size = fs.statSync(mp4File).size;
      console.log(`[rec] finalizado: ${path.basename(mp4File)} (${size} bytes)`);
      fs.unlink(tsFile, () => {});
    } else {
      // mantem o .ts para retentar no proximo boot
      console.error(`[rec] remux falhou (exit ${code}), .ts mantido: ${errLog.trim()}`);
    }
  });
}

function startRecording() {
  if (rec) return { ok: true, already: true, file: path.basename(rec.file).replace(/\.ts$/i, '.mp4') };

  const file = path.join(REC_DIR, `rec-${stamp()}.ts`);
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    '-use_wallclock_as_timestamps', '1',
    '-i', RTSP,
    '-an',
    '-c:v', 'copy',
    '-flush_packets', '1',
    '-f', 'mpegts',
    '-y', file
  ];

  const proc = spawn(FFMPEG, args, { windowsHide: true });
  const state = { proc, file, started: Date.now(), stopping: false };
  rec = state;

  proc.stderr.on('data', (d) => console.error('[rec]', d.toString().trim()));
  proc.on('exit', () => {
    // remux somente apos o ffmpeg soltar o arquivo
    finalizeTs(state.file);
  });
  proc.on('error', (e) => { console.error('[rec] erro:', e.message); });

  return { ok: true, file: path.basename(file).replace(/\.ts$/i, '.mp4') };
}

function stopRecording() {
  if (!rec) return { ok: true, stopped: false };
  const basic = path.basename(rec.file).replace(/\.ts$/i, '.mp4');
  rec.stopping = true;
  try { rec.proc.kill('SIGKILL'); } catch (_) {}
  rec = null;
  return { ok: true, stopped: true, file: basic };
}

/* se o PC desligou no meio da gravacao, converte os .ts orfaos */
function recoverOrphans() {
  const tsFiles = fs.readdirSync(REC_DIR).filter((f) => /\.ts$/i.test(f));
  tsFiles.forEach((f) => finalizeTs(path.join(REC_DIR, f)));
}

/* ------------------------------------------------------------- streaming */

function pipeMjpeg(req, res) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', RTSP,
    '-an',
    '-vf', `fps=${FPS}`,
    '-f', 'mpjpeg',
    '-q:v', '6',
    '-'
  ];
  const proc = spawn(FFMPEG, args, { windowsHide: true });

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'close'
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { proc.kill('SIGKILL'); } catch (_) {}
  };

  proc.stdout.pipe(res);
  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.error('[stream]', s);
  });
  proc.on('error', (e) => {
    console.error('[stream] ffmpeg:', e.message);
    cleanup();
    try { res.end(); } catch (_) {}
  });
  proc.on('exit', () => { cleanup(); try { res.end(); } catch (_) {} });

  req.on('close', cleanup);
  res.on('close', cleanup);
}

function snapshot(res, download) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', RTSP,
    '-frames:v', '1',
    '-q:v', '2',
    '-f', 'image2',
    '-vcodec', 'mjpeg',
    '-'
  ];
  const proc = spawn(FFMPEG, args, { windowsHide: true });
  const chunks = [];
  proc.stdout.on('data', (c) => chunks.push(c));
  proc.on('error', (e) => sendJson(res, 500, { ok: false, error: e.message }));
  proc.on('exit', (code) => {
    const buf = Buffer.concat(chunks);
    if (!buf.length) return sendJson(res, 502, { ok: false, error: 'sem imagem' });
    const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' };
    if (download) headers['Content-Disposition'] = `attachment; filename="foto-${stamp()}.jpg"`;
    send(res, 200, buf, headers);
  });
}

/* ---------------------------------------------------------------- rotas */

function listRecordings() {
  return fs.readdirSync(REC_DIR)
    .filter((f) => /\.(mp4|mkv|avi|ts)$/i.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(REC_DIR, f));
      return { file: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/stream.mjpg') return pipeMjpeg(req, res);

    if (p === '/snap.jpg') return snapshot(res, url.searchParams.get('download') === '1');

    if (p === '/api/status') {
      const online = await cameraOnline();
      return sendJson(res, 200, {
        online,
        camera: CAMERA_NAME,
        recording: rec ? { file: path.basename(rec.file), since: rec.started } : null,
        uptime: process.uptime()
      });
    }

    if (p === '/api/record/start' && req.method === 'POST') return sendJson(res, 200, startRecording());
    if (p === '/api/record/stop' && req.method === 'POST') return sendJson(res, 200, stopRecording());
    if (p === '/api/recordings') return sendJson(res, 200, listRecordings());

    if (p.startsWith('/recordings/')) {
      const name = path.basename(decodeURIComponent(p.slice('/recordings/'.length)));
      const file = path.join(REC_DIR, name);
      if (!fs.existsSync(file)) return send(res, 404, 'not found');
      const st = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': st.size,
        'Cache-Control': 'no-store'
      });
      return fs.createReadStream(file).pipe(res);
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'rota inexistente' });

    return serveStatic(req, res, p);
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
    else try { res.end(); } catch (_) {}
  }
});

server.listen(PORT, '0.0.0.0', () => {
  recoverOrphans();
  console.log(`\n  ${CAMERA_NAME}`);
  console.log(`  local:   http://localhost:${PORT}`);
  for (const [name, addrs] of Object.entries(require('os').networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  rede:    http://${a.address}:${PORT}   (${name})`);
    }
  }
  console.log('  ctrl+c para parar\n');
});

process.on('SIGINT', () => { stopRecording(); process.exit(0); });
process.on('SIGTERM', () => { stopRecording(); process.exit(0); });
