'use strict';
/*
 * CamApp v2 — servidor local da camera IP
 * Node >= 18, zero dependencias. Usas ffmpeg para RTSP e proxies PSIA/YG pra PTZ + configuracao.
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
const PHOTO_DIR = path.join(ROOT, 'photos');
const CFG_FILE = path.join(ROOT, 'config.json');

function loadConfig() {
  const defaults = {
    port: 8080,
    rtsp: 'rtsp://admin:admin123456@10.0.0.110:8554/profile0',
    ffmpeg: 'bin/ffmpeg.exe',
    cameraName: 'Câmera',
    httpBase: 'http://10.0.0.110',
    presets: {
      ultra:  { label: 'Ultra',    fps: 15, width: 0,    quality: 3 },
      alta:   { label: 'Alta',    fps: 10, width: 1280, quality: 5 },
      media:  { label: 'Média',   fps: 8,  width: 960,  quality: 6 },
      economia:{ label: 'Economia', fps: 5, width: 640,  quality: 7 }
    },
    ptzChannel: 0
  };
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    return Object.assign({}, defaults, raw);
  } catch (_) {
    return defaults;
  }
}

const CFG = loadConfig();
const PORT = CFG.port || 8080;
let RTSP = CFG.rtsp;

/* troca credenciais da camera em config.json (apos mudar senha do admin) */
function persistConfig() {
  try {
    const clean = JSON.parse(JSON.stringify(CFG));
    fs.writeFileSync(CFG_FILE, JSON.stringify(clean, null, 2));
  } catch (e) { console.error('[config] falhou ao salvar:', e.message); }
}

function updateCameraPassword(newPassword) {
  try {
    const m = /^(rtsp:\/\/)([^:]+)(:[^@]+@)/.exec(CFG.rtsp);
    if (!m) throw new Error('rtsp sem credencial');
    CFG.rtsp = m[1] + m[2] + ':' + newPassword + '@' + CFG.rtsp.slice(m[1].length + m[2].length + m[3].length);
    RTSP = CFG.rtsp;
    persistConfig();
    console.log('[config] senha do RTSP atualizada em config.json');
  } catch (e) {
    console.error('[config]', e.message);
  }
}

const FFMPEG = path.isAbsolute(CFG.ffmpeg) ? CFG.ffmpeg : path.join(ROOT, CFG.ffmpeg);
const HTTP_BASE = (CFG.httpBase || 'http://10.0.0.110').replace(/\/$/, '');

fs.mkdirSync(REC_DIR, { recursive: true });
fs.mkdirSync(PHOTO_DIR, { recursive: true });

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

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------------------------- PSIA (camera HTTP API) */

async function psiaRequest(method, urlPath, { timeout = 4000 } = {}) {
  const url = HTTP_BASE + urlPath;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e.message };
  } finally {
    clearTimeout(t);
  }
}

async function psiaRetry(method, urlPath, opts = {}) {
  let last = null;
  for (let i = 0; i < 3; i++) {
    const r = await psiaRequest(method, urlPath, opts);
    if (r.ok || (r.status && r.status !== 0)) return r;
    last = r;
    await new Promise((s) => setTimeout(s, 400 * (i + 1)));
  }
  return last;
}

function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/* ------------------------------------------------------------- streaming */

function streamingArgs(presetName) {
  const presets = CFG.presets || {};
  const p = presets[presetName] || presets.alta || { fps: 10, width: 0, quality: 5 };
  const vf = [`fps=${p.fps}`];
  if (p.width) vf.push(`scale=${p.width}:-2:flags=bilinear`);
  return [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-use_wallclock_as_timestamps', '1',
    '-i', RTSP,
    '-an',
    '-vf', vf.join(','),
    '-f', 'mpjpeg',
    '-q:v', String(p.quality),
    '-'
  ];
}

/* quantas sessoes ffmpeg de stream estao abertas, pra painel */
let streamSessions = 0;

function pipeMjpeg(req, res, url) {
  const presetName = url.searchParams.get('q') || 'alta';
  const proc = spawn(FFMPEG, streamingArgs(presetName), { windowsHide: true });
  streamSessions++;

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'close',
    'X-Accel-Buffering': 'no'
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    streamSessions = Math.max(0, streamSessions - 1);
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

function grabFrame(res, opts = {}) {
  const { download = false, save = false } = opts;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-use_wallclock_as_timestamps', '1',
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
    if (!buf.length) return sendJson(res, 502, { ok: false, error: 'sem imagem (tenta de novo)' });
    const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' };
    if (save) {
      const name = `foto-${stamp()}.jpg`;
      fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
      if (download) headers['Content-Disposition'] = `attachment; filename="${name}"`;
      sendJson(res, 200, { ok: true, file: name, url: `/photos/${name}` });
      return;
    }
    if (download) headers['Content-Disposition'] = `attachment; filename="foto-${stamp()}.jpg"`;
    send(res, 200, buf, headers);
  });
}

/* ------------------------------------------------------------- gravacao */

let rec = null; // { proc, file, started, stopping }

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

/* ------------------------------------------------------------ PTZ (YG/PSIA) */

const PTZ = (CFG.ptzChannel == null ? 0 : CFG.ptzChannel);

/* implementacao direta pra cada acao PTZ */
async function ptzProxy(action, body = {}) {
  const base = `/PSIA/YG/PTZCtrl/channels/${PTZ}/continuous`;
  switch (action) {
    case 'move':      return psiaRetry('PUT', `${base}?pan=${body.pan || 0}&tilt=${body.tilt || 0}`);
    case 'stop':      return psiaRetry('PUT', `${base}?pan=0&tilt=0`);
    case 'zoomIn':    return psiaRetry('PUT', `${base}/zoom?data=1`);
    case 'zoomOut':   return psiaRetry('PUT', `${base}/zoom?data=-1`);
    case 'zoomStop':  return psiaRetry('PUT', `${base}/zoom?data=0`);
    case 'focusIn':   return psiaRetry('PUT', `${base}/focus?data=1`);
    case 'focusOut':  return psiaRetry('PUT', `${base}/focus?data=-1`);
    case 'focusStop': return psiaRetry('PUT', `${base}/focus?data=0`);
    case 'autoFocus': return psiaRetry('PUT', `${base}/focus?data=3`);
    case 'irisIn':    return psiaRetry('PUT', `${base}/iris?data=1`);
    case 'irisOut':   return psiaRetry('PUT', `${base}/iris?data=-1`);
    case 'irisStop':  return psiaRetry('PUT', `${base}/iris?data=0`);
    case 'autoPan':   return psiaRetry('PUT', `${base}/autoPan?data=${body.on ? 1 : 0}`);
    case 'speed':     return psiaRetry('PUT', `/PSIA/YG/PTZCtrl/speed?data=${body.n || 1}`);
    case 'caps':      return psiaRetry('GET', `/PSIA/YG/PTZCtrl/channels/${PTZ}/capabilities`);
    case 'gotoPreset':   return psiaRetry('PUT', `/PSIA/YG/PTZCtrl/channels/${PTZ}/presets/${body.id}/goto`);
    case 'delPreset':    return psiaRetry('DELETE', `/PSIA/YG/PTZCtrl/channels/${PTZ}/presets/${body.id}`);
    case 'setPreset':    return psiaRetry('PUT', `/PSIA/YG/PTZCtrl/channels/${PTZ}/presets/${body.id}`);
    default: return { ok: false, status: 400, body: 'acao ptz desconhecida' };
  }
}

/* --------------------------------------------------------- painel de config */

const CAM_KEYS = new Set([
  'YG/system/time', 'YG/system/ntpServers',
  'YG/videoSetting/0', 'YG/videoSetting/1',
  'YG/videoSetting/0/capabilities', 'YG/videoSetting/1/capabilities',
  'YG/OSD/OSDConfig/0', 'YG/OSD/OSDConfig/1',
  'YG/audioSetting', 'YG/event/motionDetection', 'YG/event/faceDetection',
  'YG/authentication/rtsp', 'YG/authentication/onvif',
  'YG/netWork/DDNS', 'YG/netWork/email',
  'Security/AAA/users', 'System/deviceInfo', 'System/status'
]);

const CAM_WRITE_KEYS = new Set([
  'YG/system/time', 'YG/system/ntpServers',
  'YG/videoSetting/0', 'YG/videoSetting/1',
  'YG/OSD/OSDConfig/0', 'YG/OSD/OSDConfig/1',
  'YG/audioSetting', 'YG/event/motionDetection', 'YG/event/faceDetection',
  'YG/authentication/rtsp', 'YG/authentication/onvif',
  'YG/netWork/DDNS', 'YG/netWork/email'
]);

function xmlApplyEdits(xml, edits) {
  const missing = [];
  let out = xml;
  for (const [tag, value] of Object.entries(edits)) {
    const re = new RegExp(`<${tag}([^>]*)>[\\s\\S]*?</${tag}>`);
    if (!re.test(out)) { missing.push(tag); continue; }
    out = out.replace(re, `<${tag}$1>${value}</${tag}>`);
  }
  return { xml: out, missing };
}

/* PUT de XML psia com validacao do statusString do firmware */
async function psiaPutXml(urlPath, xml) {
  const url = HTTP_BASE + urlPath;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/xml' },
      body: xml,
      signal: ctrl.signal
    });
    const body = await res.text();
    const m = /<statusString>([^<]+)<\/statusString>/.exec(body);
    return { ok: res.ok, status: res.status, statusString: m ? m[1] : (res.ok ? 'OK' : 'HTTP ' + res.status) };
  } catch (e) {
    return { ok: false, status: 0, statusString: e.message };
  } finally {
    clearTimeout(t);
  }
}

async function camGetByPath(key) {
  if (!CAM_KEYS.has(key)) return { ok: false, statusString: 'path fora da lista' };
  const r = await psiaRetry('GET', '/PSIA/' + key);
  return r.ok ? { ok: true, xml: r.body } : { ok: false, statusString: r.statusString || 'HTTP ' + r.status };
}

/* grava ?path=chave  |  recebe {edits:{tag:valor}} e aplica sobre o estado real */
async function camPutByPath(key, edits, opts) {
  if (!CAM_WRITE_KEYS.has(key) && key !== 'Security/AAA/users') {
    return { ok: false, statusString: 'path fora da lista' };
  }

  /* autenticacao rtsp/onvif usam query ?enabled=, sem corpo */
  if (key === 'YG/authentication/rtsp' || key === 'YG/authentication/onvif') {
    const val = String(edits.enabled === undefined ? 'true' : edits.enabled);
    const r = await psiaRequest('PUT', `/PSIA/${key}?enabled=${val}`, { timeout: 5000 });
    return r.ok ? { ok: true, statusString: 'OK' } : { ok: false, statusString: 'HTTP ' + r.status };
  }

  /* detecca de movimento exige tudo em query string (formato do firmware) */
  if (key === 'YG/event/motionDetection') {
    const cur = await psiaRetry('GET', '/PSIA/' + key);
    if (!cur.ok) return { ok: false, statusString: 'GET motionDetection falhou' };
    const x = cur.body;
    const cells = (x.match(/<mdCell[^>]*>([\d]+)<\/mdCell>/g) || []).length;
    const cols = parseInt(xmlText(x, 'mdColumn'), 10) || 22;
    const params = new URLSearchParams();
    const q = (tag, fb) => edits[tag] !== undefined ? String(edits[tag]) : (xmlText(x, tag) || fb);
    params.set('MotionType', q('MotionType', 'disable'));
    params.set('sensitivityLevel', q('sensitivityLevel', '50'));
    params.set('isSendMail', q('isSendMail', 'false'));
    params.set('isBuzz', q('isBuzz', 'false'));
    params.set('traceMode', q('traceMode', 'disable'));
    params.set('mailInterval', q('mailInterval', '300'));
    params.set('motionInterval', q('motionInterval', '10'));
    params.set('mdRow', String(cells));
    params.set('mdColumn', String(cols));
    const all = opts && (opts.mdCellAll === '1' || opts.mdCellAll === '0') ? opts.mdCellAll : null;
    for (let i = 0; i < cells; i++) {
      let rowStr;
      if (all !== null) rowStr = new Array(cols + 1).join(all);
      else {
        const m = new RegExp(`<mdCell[\\s\\S]*?>([\\d]+)</mdCell>`);
        rowStr = null;
      }
      params.set('mdCell' + i, rowStr != null ? rowStr : xmlNth(x, 'mdCell', i));
    }
    const r = await psiaRequest('PUT', `/PSIA/${key}?${params.toString()}`, { timeout: 5000 });
    const st = /<statusString>([^<]+)<\/statusString>/.exec(r.body || '');
    return r.ok && (!st || st[1] === 'OK')
      ? { ok: true, statusString: st ? st[1] : 'OK' }
      : { ok: false, statusString: st ? st[1] : 'HTTP ' + r.status };
  }

  const cur = await psiaRetry('GET', '/PSIA/' + key);
  if (!cur.ok) return { ok: false, statusString: 'GET falhou antes do PUT' };
  const { xml, missing } = xmlApplyEdits(cur.body, edits);
  if (missing.length) return { ok: false, statusString: 'tags inexistentes: ' + missing.join(', ') };

  let outXml = xml;
  /* grade de movimento: liga/desliga todas as celulas de uma vez */
  if (opts && opts.mdCellAll && key === 'YG/event/motionDetection') {
    const cols = parseInt(xmlText(xml, 'mdColumn'), 10) || 22;
    const char = opts.mdCellAll === '1' ? '1' : '0';
    const row = new Array(cols + 1).join(char);
    outXml = xml.replace(/<mdCell[\s\S]*?<\/mdCell>/g, `<mdCell>${row}</mdCell>`);
  }

  const put = await psiaPutXml('/PSIA/' + key, outXml);
  return put.ok ? { ok: true, statusString: put.statusString } : { ok: false, statusString: put.statusString };
}

/* sincroniza relogio da camera com o do PC */
async function camSyncClock() {
  const cur = await psiaRetry('GET', '/PSIA/YG/system/time');
  if (!cur.ok) return { ok: false, statusString: 'GET time falhou' };
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const now = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const { xml, missing } = xmlApplyEdits(cur.body, { timeMode: 'manual', localTime: now });
  if (missing.length) return { ok: false, statusString: 'tags: ' + missing.join(',') };
  const r = await psiaPutXml('/PSIA/YG/system/time', xml);
  return r;
}

/* troca senha de um usuario (inclusive admin) */
async function camChangeUser(body) {
  const userName = String(body.userName || '').trim();
  let password = String(body.password || '');
  const userType = String(body.userType || 'admin');
  if (!userName || password.length < 1) {
    return { ok: false, statusString: 'dados incompletos' };
  }
  const r = await psiaRetry('GET', '/PSIA/Security/AAA/users', { timeout: 4000 });
  if (!r.ok) return { ok: false, statusString: 'GET users falhou' };
  const list = xmlList(r.body, 'User');
  /* firmware usa o INDICE na lista (0-based), nao o <id> do XML */
  const idx = list.findIndex((u) => u.userName === userName);
  if (idx < 0) return { ok: false, statusString: 'usuario ' + userName + ' nao encontrado' };
  password = encodeURIComponent(password);
  const rr = await psiaRequest('PUT', `/PSIA/Security/AAA/users/${idx}?userName=${encodeURIComponent(userName)}&password=${password}&userType=${userType}`, { timeout: 5000 });
  let st = /<statusString>([^<]+)<\/statusString>/.exec(rr.body || '');
  return rr.ok && st && st[1] === 'OK'
    ? { ok: true, statusString: 'OK' }
    : { ok: false, statusString: st ? st[1] : 'HTTP ' + rr.status };
}

function xmlCount(xml, tag) {
  return (xml.match(new RegExp(`<${tag}[^>]*>`, 'g')) || []).length;
}

function xmlNth(xml, tag, n) {
  let c = 0;
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    if (c === n) return m[1];
    c++;
  }
  return new Array((parseInt(xmlText(xml, 'mdColumn'), 10) || 22) + 1).join('1');
}

function xmlList(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    const blob = m[0];
    const get = (t) => xmlText(blob, t);
    out.push({
      id: get('id'),
      userName: get('userName'),
      password: get('password'),
      userType: get('userType')
    });
  }
  return out;
}

/* --------------------------------------------------------- rotas/helpers */


async function getBitrate() {
  const r = await psiaRequest('GET', '/PSIA/YG/curBitrate/0', { timeout: 1500 });
  if (!r.ok) return null;
  return xmlText(r.body, 'CurBitrate') || null;
}

function cameraOnline() {
  const u = new URL(RTSP);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port) || 554 });
    const done = (ok) => { try { s.destroy(); } catch (_) {} resolve(ok); };
    s.setTimeout(1500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function telnetOpen() {
  const u = new URL(RTSP);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: 23 });
    const done = (ok) => { try { s.destroy(); } catch (_) {} resolve(ok); };
    s.setTimeout(1500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function listRecordings() {
  return fs.readdirSync(REC_DIR)
    .filter((f) => /\.(mp4|mkv|avi|ts)$/i.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(REC_DIR, f));
      return { file: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function listPhotos() {
  return fs.readdirSync(PHOTO_DIR)
    .filter((f) => /\.jpe?g$/i.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(PHOTO_DIR, f));
      return { file: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function serveFile(req, res, absDir, relName, mimeOverride) {
  const name = path.basename(decodeURIComponent(relName));
  const file = path.join(absDir, name);
  if (!fs.existsSync(file)) return send(res, 404, 'not found');
  const st = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': mimeOverride || MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(file).pipe(res);
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

function readBody(req) {
  return new Promise((resolve) => {
    const data = [];
    req.on('data', (c) => data.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(data).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { resolve({}); }
    });
  });
}

function parseDeviceJson() {
  return psiaRetry('GET', '/PSIA/System/deviceInfo', { timeout: 4000 }).then((r) => {
    if (!r.ok) return null;
    return {
      deviceName: xmlText(r.body, 'deviceName'),
      deviceID: xmlText(r.body, 'deviceID'),
      model: xmlText(r.body, 'model'),
      serialNumber: xmlText(r.body, 'serialNumber'),
      macAddress: xmlText(r.body, 'macAddress'),
      firmwareVersion: xmlText(r.body, 'firmwareVersion'),
      bootVersion: xmlText(r.body, 'bootVersion'),
      hardwareVersion: xmlText(r.body, 'hardwareVersion')
    };
  });
}

/* ---------------------------------------------------------------- rotas */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  try {
    /* vivo */
    if (p === '/stream.mjpg') return pipeMjpeg(req, res, url);
    if (p === '/snap.jpg')    return grabFrame(res, { download: url.searchParams.get('download') === '1' });

    /* fotos salvas no servidor */
    if (p === '/api/photo' && method === 'POST') return grabFrame(res, { save: true });
    if (p === '/api/photos')    return sendJson(res, 200, listPhotos());
    if (p.startsWith('/photos/'))    return serveFile(req, res, PHOTO_DIR, p.slice('/photos/'.length));
    if (p.startsWith('/api/photo/') && method === 'DELETE') {
      const name = path.basename(p.slice('/api/photo/'.length));
      fs.unlink(path.join(PHOTO_DIR, name), () => sendJson(res, 200, { ok: true }));
      return;
    }

    /* gravacao */
    if (p === '/api/record/start' && method === 'POST') return sendJson(res, 200, startRecording());
    if (p === '/api/record/stop'  && method === 'POST') return sendJson(res, 200, stopRecording());
    if (p === '/api/recordings')   return sendJson(res, 200, listRecordings());
    if (p.startsWith('/api/recording/') && method === 'DELETE') {
      const name = path.basename(p.slice('/api/recording/'.length));
      fs.unlink(path.join(REC_DIR, name), () => sendJson(res, 200, { ok: true }));
      return;
    }
    if (p.startsWith('/recordings/')) return serveFile(req, res, REC_DIR, p.slice('/recordings/'.length), 'video/mp4');

    /* status / dispositivo */
    if (p === '/api/status') {
      const [online, bitrate] = await Promise.all([cameraOnline(), getBitrate()]);
      return sendJson(res, 200, {
        online,
        camera: CFG.cameraName,
        recording: rec ? { file: path.basename(rec.file).replace(/\.ts$/i, '.mp4'), since: rec.started } : null,
        bitrate,
        streams: streamSessions,
        uptime: Math.floor(process.uptime()),
        presets: CFG.presets ? Object.fromEntries(Object.entries(CFG.presets).map(([k, v]) => [k, v])) : undefined
      });
    }

    if (p === '/api/device') {
      const [dev, portsR, faceR, tel] = await Promise.all([
        parseDeviceJson(),
        psiaRequest('GET', '/PSIA/YG/netWork/getAllPort', { timeout: 3000 }).catch(() => null),
        psiaRequest('GET', '/PSIA/YG/event/faceDetection', { timeout: 3000 }).catch(() => null),
        telnetOpen().catch(() => false)
      ]);
      const ports = [];
      if (portsR && portsR.ok) {
        const re = /<AccessProtocol[\s\S]*?<\/AccessProtocol>/g;
        let m;
        while ((m = re.exec(portsR.body))) {
          const blob = m[0];
          ports.push({ proto: xmlText(blob, 'protocol'), port: xmlText(blob, 'portNo') });
        }
      }
      const face = faceR && faceR.ok
        ? { enabled: xmlText(faceR.body, 'enabled'), main: xmlText(faceR.body, 'mainFaceDetect'), sub: xmlText(faceR.body, 'subFaceDetect') }
        : null;
      return sendJson(res, 200, {
        ok: !!(dev || portsR?.ok),
        device: dev,
        ports,
        faceDetection: face,
        telnetOpen: tel,
        httpBase: HTTP_BASE,
        adminUiUrl: HTTP_BASE + '/doc/page/login.html'
      });
    }

    /* PTZ */
    if (p === '/api/ptz/presets' && method === 'GET') {
      const r = await psiaRetry('GET', `/PSIA/YG/PTZCtrl/channels/${PTZ}/presets`);
      if (!r.ok) return sendJson(res, 502, { ok: false });
      const rx = /<PTZPreset[\s\S]*?<\/PTZPreset>/g;
      const items = [];
      let m;
      while ((m = rx.exec(r.body))) {
        const blob = m[0];
        items.push({
          id: xmlText(blob, 'presetID') || xmlText(blob, 'id'),
          name: xmlText(blob, 'presetName') || xmlText(blob, 'name')
        });
      }
      return sendJson(res, 200, { ok: true, presets: items, maxPresetNum: 16 });
    }
    if (p.startsWith('/api/ptz') && method === 'POST') {
      const action = p.slice('/api/ptz'.length).replace(/^\//, '').split('/')[0];
      const body = await readBody(req);
      const r = await ptzProxy(action, body);
      return sendJson(res, r.ok ? 200 : 502, { ok: r.ok, status: r.status });
    }

    /* painel de configuracao (usurpa o painel de fabrica) */
    if (p === '/api/cam' && method === 'GET') {
      const key = url.searchParams.get('path');
      const r0 = await camGetByPath(key);
      let extra = null;
      if (r0.ok && key === 'Security/AAA/users') extra = xmlList(r0.xml, 'User');
      if (r0.ok && key === 'YG/event/motionDetection') extra = { mdColumn: xmlText(r0.xml, 'mdColumn'), mdRow: xmlText(r0.xml, 'mdRow'), cellCount: xmlCount(r0.xml, 'mdCell') };
      return sendJson(res, r0.ok ? 200 : 502, Object.assign({ ok: r0.ok, path: key }, r0, extra ? { list: extra } : {}));
    }
    if (p === '/api/cam' && method === 'PUT') {
      const body = await readBody(req);
      const key = body.path;
      console.error('[painel] PUT', key, body.mdCellAll || '');
      if (key === 'YG/system/time') return sendJson(res, 200, await camSyncClock());
      const r = await camPutByPath(key, body.edits || {}, { mdCellAll: body.mdCellAll });
      console.error('[painel] PUT', key, '->', JSON.stringify(r).slice(0, 160));
      if (r.ok) console.error(`[painel] ${key}: aplicado ok do firmware`);
      return sendJson(res, r.ok ? 200 : 502, r);
    }
    if (p === '/api/user/password' && method === 'POST') {
      const body = await readBody(req);
      const oldRtsp = CFG.rtsp;
      const r = await camChangeUser(body);
      if (r.ok && body.userName === 'admin') updateCameraPassword(body.password);
      return sendJson(res, r.ok ? 200 : 502, Object.assign(r, {
        mustUpdateConfig: r.ok && body.userName === 'admin'
      }));
    }

    if (p === '/api/reboot' && method === 'POST') {
      const r = await psiaRetry('POST', '/PSIA/System/reboot', { timeout: 5000 });
      return sendJson(res, r.ok ? 200 : r.status, { ok: r.ok, status: r.status });
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
  console.log(`\n  ${CFG.cameraName}  (presets: ${Object.keys(CFG.presets || {}).join(', ')})`);
  for (const [name, addrs] of Object.entries(require('os').networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  rede:    http://${a.address}:${PORT}   (${name})`);
    }
  }
  console.log('  ctrl+c para parar\n');
});

process.on('SIGINT', () => { if (rec) stopRecording(); process.exit(0); });
process.on('SIGTERM', () => { if (rec) stopRecording(); process.exit(0); });
