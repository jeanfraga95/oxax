/**
 * OXAX Relay v4 — Arquitetura Híbrida
 *
 * Problema: o servidor VPS é bloqueado pelo oxax.tv (host_not_allowed)
 *
 * Solução em 2 modos:
 *
 * MODO A — Player Web (browser do usuário):
 *   O browser do usuário tem IP residencial → acessa oxax.tv normalmente
 *   A página /canal/:slug faz o browser extrair o kodk via JS,
 *   registra no servidor (/api/register), e inicia o stream
 *   ✅ Funciona imediatamente, sem puppeteer
 *
 * MODO B — VLC/IPTV (puppeteer headless, se chromium instalado):
 *   /stream/:slug.m3u8 tenta usar token já registrado pelo browser
 *   Se não houver token, tenta puppeteer como fallback
 *   ✅ Funciona depois que o usuário abre o player web uma vez
 */

'use strict';

const express = require('express');
const axios   = require('axios');
const https   = require('https');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ── Canais ────────────────────────────────────────────────────────────────────
const CHANNELS = {
  'brazzers-tv-europe' : 'https://oxax.tv/brazzers-tv-europe.html',
  'private-tv'         : 'https://oxax.tv/private-tv.html',
  'penthouse-tv'       : 'https://oxax.tv/penthouse-tv.html',
  'vivid-tv'           : 'https://oxax.tv/vivid-tv.html',
  'playboy-tv'         : 'https://oxax.tv/playboy-tv.html',
  'hustler-tv'         : 'https://oxax.tv/hustler-tv.html',
  'reality-kings-tv'   : 'https://oxax.tv/reality-kings-tv.html',
  'mia-tv'             : 'https://oxax.tv/mia-tv.html',
  'dorcel-tv'          : 'https://oxax.tv/dorcel-tv.html',
  'club-clipz'         : 'https://oxax.tv/club-clipz.html',
  'private-spice-hd'   : 'https://oxax.tv/private-spice-hd.html',
  'erox-tv'            : 'https://oxax.tv/erox-tv.html',
  'pink-erotic'        : 'https://oxax.tv/pink-erotic.html',
  'erotic-travel'      : 'https://oxax.tv/erotic-travel.html',
};

// ── Token store (kodk/kos registrados pelo browser do usuário) ────────────────
// { slug: { kodk, kos, hash, m3u8Url, cookies, ts } }
const tokens   = {};
const CACHE_TTL = 25 * 60 * 1000; // 25 min

// ── Monta URL do stream a partir de kodk + kos + hash ─────────────────────────
function buildM3U8Url(kodk, kos, hash) {
  let base = 'https://s.oxax.tv/';
  if (hash && kos) {
    const mid = Math.floor(kos.length / 2);
    base = `https://s.oxax.tv/${kos.slice(0, mid)}${hash}${kos.slice(mid)}/`;
  } else if (hash) {
    base = `https://s.oxax.tv/${hash}/`;
  }
  return base + kodk;
}

// ── Verifica se token é válido ────────────────────────────────────────────────
function hasValidToken(slug) {
  return tokens[slug] && (Date.now() - tokens[slug].ts) < CACHE_TTL;
}

// ── Tenta puppeteer como fallback (se chromium instalado) ─────────────────────
async function tryPuppeteer(slug) {
  const channelUrl = CHANNELS[slug];
  const PATHS = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome'];
  const execPath = PATHS.find(p => fs.existsSync(p));
  if (!execPath) throw new Error('Chromium não instalado. Acesse /canal/' + slug + ' no browser primeiro.');

  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch (_) { throw new Error('puppeteer-core não instalado. Acesse /canal/' + slug + ' no browser primeiro.'); }

  console.log(`[puppeteer] abrindo ${slug}...`);
  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--no-first-run','--single-process','--mute-audio'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });

    let capturedM3U8 = null;
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (!capturedM3U8 && url.includes('s.oxax.tv') && url.includes('.m3u8')) capturedM3U8 = url;
      req.continue().catch(() => {});
    });

    const resp = await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    console.log(`[puppeteer] ${slug} HTTP ${resp.status()}`);

    // Aguarda até 12s pelo m3u8
    for (let i = 0; i < 24 && !capturedM3U8; i++) await new Promise(r => setTimeout(r, 500));

    const html = await page.content();
    const kodk = html.match(/var\s+kodk\s*=\s*["']([^"']+)["']/)?.[1];
    const kos  = html.match(/var\s+kos\s*=\s*["']([^"']+)["']/)?.[1] || '';

    let hash = '';
    const pjM = html.match(/new\s+Playerjs\s*\(\s*["']#?([A-Za-z0-9+/=]+)["']\s*\)/);
    if (pjM) {
      try {
        const dec = Buffer.from(pjM[1], 'base64').toString();
        const fm  = dec.match(/s\.oxax\.tv\/(?:\{v1\})?([a-z0-9]+)(?:\{v2\})?/);
        if (fm) hash = fm[1];
      } catch (_) {}
    }

    const m3u8Url = capturedM3U8 || (kodk ? buildM3U8Url(kodk, kos, hash) : null);
    if (!m3u8Url) throw new Error('Não foi possível capturar o m3u8 via puppeteer');

    const pageCookies = await page.cookies();
    const cookies = pageCookies.map(c => `${c.name}=${c.value}`).join('; ');

    tokens[slug] = { kodk, kos, hash, m3u8Url, cookies, ts: Date.now() };
    console.log(`[puppeteer] ${slug} → ${m3u8Url}`);
    return tokens[slug];

  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Obtém token válido (store → puppeteer) ─────────────────────────────────────
async function getToken(slug) {
  if (hasValidToken(slug)) return tokens[slug];
  return tryPuppeteer(slug);
}

// ── Headers para requisições ao stream ───────────────────────────────────────
function streamHeaders(cookies) {
  return {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer'        : 'https://oxax.tv/',
    'Origin'         : 'https://oxax.tv',
    'Accept'         : '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Accept-Encoding': 'identity',
    ...(cookies ? { Cookie: cookies } : {}),
  };
}

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── POST /api/register — browser do usuário registra o token ─────────────────
// Body: { slug, kodk, kos, hash, m3u8Url, cookies }
app.post('/api/register', (req, res) => {
  const { slug, kodk, kos, hash, m3u8Url, cookies } = req.body;
  if (!slug || !CHANNELS[slug]) return res.status(400).json({ error: 'slug inválido' });
  if (!kodk && !m3u8Url) return res.status(400).json({ error: 'kodk ou m3u8Url obrigatório' });

  const url = m3u8Url || buildM3U8Url(kodk, kos || '', hash || '');
  tokens[slug] = { kodk, kos, hash, m3u8Url: url, cookies: cookies || '', ts: Date.now() };
  console.log(`[register] ${slug} → ${url}`);
  res.json({ ok: true, m3u8Url: url });
});

// ── GET /api/token/:slug — status do token (debug) ───────────────────────────
app.get('/api/token/:slug', (req, res) => {
  const t = tokens[req.params.slug];
  if (!t) return res.json({ registered: false });
  res.json({ registered: true, m3u8Url: t.m3u8Url, age: Math.round((Date.now()-t.ts)/60000)+'min' });
});

// ── GET /stream/:slug.m3u8 — link fixo M3U8 com proxy ────────────────────────
app.get('/stream/:slug.m3u8', async (req, res) => {
  const slug = req.params.slug;
  if (!CHANNELS[slug]) return res.status(404).send('Canal não encontrado');

  try {
    const { m3u8Url, cookies } = await getToken(slug);
    const host = `${req.protocol}://${req.get('host')}`;

    const m3u8Resp = await axios.get(m3u8Url, {
      headers: streamHeaders(cookies),
      httpsAgent,
      timeout: 15000,
    });

    let content = m3u8Resp.data;
    const baseDir = m3u8Url.replace(/\/[^/?#]+\.m3u8[^]*$/, '/');

    // Reescreve linhas de segmento para passar pelo proxy
    content = content.replace(/^([^#\n][^\n]*)$/gm, line => {
      const t = line.trim();
      if (!t) return line;
      const abs = t.startsWith('http') ? t : baseDir + t;
      return `${host}/proxy-ts?url=${encodeURIComponent(abs)}&slug=${slug}`;
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(content);

  } catch (err) {
    console.error(`[stream/${slug}]`, err.message);
    delete tokens[slug];
    res.status(502).send(`Erro: ${err.message}`);
  }
});

// ── GET /proxy-ts — proxy de segmentos .ts ────────────────────────────────────
app.get('/proxy-ts', async (req, res) => {
  const tsUrl = decodeURIComponent(req.query.url || '');
  const slug  = req.query.slug || '';
  if (!tsUrl.startsWith('https://s.oxax.tv/') && !tsUrl.startsWith('https://r.pokaz.me/'))
    return res.status(400).send('URL inválida');

  try {
    const cookies = tokens[slug]?.cookies || '';
    const up = await axios.get(tsUrl, {
      headers: streamHeaders(cookies),
      httpsAgent,
      responseType: 'stream',
      timeout: 20000,
    });
    res.setHeader('Content-Type', up.headers['content-type'] || 'video/MP2T');
    res.setHeader('Access-Control-Allow-Origin', '*');
    up.data.pipe(res);
  } catch (err) {
    console.error('[proxy-ts]', err.message);
    res.status(502).send('Erro proxy');
  }
});

// ── GET /canal/:slug — Player web (extrai token via browser do usuário) ───────
app.get('/canal/:slug', (req, res) => {
  const { slug } = req.params;
  if (!CHANNELS[slug]) return res.status(404).send('Canal não encontrado. <a href="/">Voltar</a>');

  const channelUrl = CHANNELS[slug];
  const host       = `${req.protocol}://${req.get('host')}`;
  const streamSrc  = `${host}/stream/${slug}.m3u8`;
  const name       = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<link href="https://vjs.zencdn.net/8.6.0/video-js.css" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box} body{background:#000;font-family:sans-serif}
  .hdr{padding:10px 18px;background:#111;display:flex;align-items:center;gap:12px}
  .hdr a{color:#f90;text-decoration:none;font-size:13px}
  .hdr h2{font-size:15px;flex:1;color:#fff}
  .hdr .tag{font-size:11px;padding:3px 8px;border-radius:10px;background:#333;color:#aaa}
  #vp{width:100%;height:calc(100vh - 44px)}
  #status{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);
          background:rgba(0,0,0,.8);color:#fff;padding:8px 18px;border-radius:20px;
          font-size:13px;display:none;z-index:999}
</style>
</head><body>
<div class="hdr">
  <a href="/">← Canais</a>
  <h2>📺 ${name}</h2>
  <span class="tag" id="tag">carregando...</span>
</div>
<video id="vp" class="video-js vjs-big-play-centered" controls preload="auto"></video>
<div id="status"></div>

<script src="https://vjs.zencdn.net/8.6.0/video.min.js"></script>
<script>
const RELAY    = '${host}';
const SLUG     = '${slug}';
const CHAN_URL = '${channelUrl}';
const STREAM   = '${streamSrc}';
const tag      = document.getElementById('tag');
const statusEl = document.getElementById('status');

function showStatus(msg, color) {
  statusEl.textContent = msg;
  statusEl.style.background = color || 'rgba(0,0,0,.8)';
  statusEl.style.display = 'block';
  clearTimeout(showStatus._t);
  showStatus._t = setTimeout(() => statusEl.style.display='none', 4000);
}

const pl = videojs('vp', { fill: true });

// Passo 1: busca a página do canal via browser do usuário (IP residencial = não bloqueado)
async function extractToken() {
  tag.textContent = 'extraindo token...';
  tag.style.background = '#333';

  let kodk, kos, hash, cookies = '';

  try {
    // Tenta buscar diretamente
    const resp = await fetch(CHAN_URL, { credentials: 'include' });
    const html = await resp.text();

    kodk = (html.match(/var kodk=["']([^"']+)["']/) || [])[1];
    kos  = (html.match(/var kos=["']([^"']+)["']/)  || [])[1] || '';

    // Extrai hash do playerjs
    const pjM = html.match(/new Playerjs\\(["']#?([A-Za-z0-9+\\/=]+)["']\\)/);
    if (pjM) {
      try {
        const dec = atob(pjM[1]);
        const fm  = dec.match(/s\\.oxax\\.tv\\/(?:\\{v1\\})?([a-z0-9]+)(?:\\{v2\\})?/);
        if (fm) hash = fm[1];
      } catch(_) {}
    }

    if (!kodk) throw new Error('kodk não encontrado no HTML');

  } catch (err) {
    console.warn('Fetch direto falhou:', err.message);
    // Tenta via iframe para bypass de CORS
    kodk = null;
  }

  if (!kodk) {
    // Fallback: carrega em iframe invisível e espera mensagem postMessage
    tag.textContent = 'carregando via iframe...';
    await loadViaIframe();
    return;
  }

  // Monta m3u8Url
  let base = 'https://s.oxax.tv/';
  if (hash && kos) {
    const mid = Math.floor(kos.length / 2);
    base = 'https://s.oxax.tv/' + kos.slice(0, mid) + hash + kos.slice(mid) + '/';
  } else if (hash) {
    base = 'https://s.oxax.tv/' + hash + '/';
  }
  const m3u8Url = base + kodk;

  await registerToken({ kodk, kos, hash, m3u8Url, cookies });
}

async function registerToken(data) {
  await fetch(RELAY + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, ...data })
  });
  tag.textContent = '● ao vivo';
  tag.style.background = '#292';
  showStatus('✅ Stream carregado!', 'rgba(0,100,0,.9)');
  pl.src({ type: 'application/x-mpegURL', src: STREAM });
  pl.play();
}

// Fallback: iframe invisível que carrega o canal e extrai via postMessage
function loadViaIframe() {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px';
    iframe.src = CHAN_URL;

    const timeout = setTimeout(() => {
      document.body.removeChild(iframe);
      // Se iframe falhar, tenta stream direto (pode funcionar com puppeteer no servidor)
      tag.textContent = '● tentando...';
      pl.src({ type: 'application/x-mpegURL', src: STREAM });
      pl.play();
      resolve();
    }, 10000);

    window.addEventListener('message', async (e) => {
      if (e.data && e.data.kodk) {
        clearTimeout(timeout);
        document.body.removeChild(iframe);
        await registerToken(e.data);
        resolve();
      }
    });

    document.body.appendChild(iframe);
  });
}

// Inicia extração
extractToken().catch(err => {
  console.error('Extração falhou:', err);
  tag.textContent = 'erro';
  tag.style.background = '#933';
  // Tenta carregar o stream direto de qualquer forma
  pl.src({ type: 'application/x-mpegURL', src: STREAM });
  pl.play();
});

// Link fixo para copiar
document.querySelector('.hdr').insertAdjacentHTML('beforeend',
  '<small style="color:#555;font-size:10px;word-break:break-all">' + STREAM + '</small>');
</script>
</body></html>`);
});

// ── GET /playlist.m3u ─────────────────────────────────────────────────────────
app.get('/playlist.m3u', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  let m3u = '#EXTM3U\n\n';
  for (const [slug] of Object.entries(CHANNELS)) {
    const name = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    m3u += `#EXTINF:-1 tvg-id="${slug}" tvg-name="${name}" group-title="OXAX",${name}\n`;
    m3u += `${host}/stream/${slug}.m3u8\n\n`;
  }
  res.setHeader('Content-Type', 'application/x-mpegURL');
  res.setHeader('Content-Disposition', 'attachment; filename="oxax.m3u"');
  res.send(m3u);
});

// ── GET / — Lista de canais ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  const rows = Object.entries(CHANNELS).map(([slug]) => {
    const name   = slug.replace(/-/g,' ').replace(/\b\w/g, l => l.toUpperCase());
    const ok     = hasValidToken(slug);
    const player = `${host}/canal/${slug}`;
    const m3u8   = `${host}/stream/${slug}.m3u8`;
    return `<tr>
      <td><b>${name}</b> ${ok ? '<span style="color:#6f6;font-size:10px">● live</span>' : ''}</td>
      <td><a href="${player}" target="_blank">▶ Player</a></td>
      <td style="font-size:11px"><a href="${m3u8}">${m3u8}</a></td>
      <td><button onclick="cp('${m3u8}',this)">📋</button></td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OXAX Relay</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:sans-serif;background:#111;color:#eee;padding:20px}
  h1{color:#f90;margin-bottom:10px}
  .info{background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:14px 18px;
        margin-bottom:22px;font-size:13px;line-height:2}
  .info a,.info code{color:#6af}.info code{background:#000;padding:2px 6px;border-radius:3px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#f90;color:#000;padding:8px 12px;text-align:left}
  td{padding:7px 12px;border-bottom:1px solid #333;vertical-align:middle}
  tr:hover td{background:#1a1a1a}
  a{color:#6af;text-decoration:none;word-break:break-all}
  button{background:#333;color:#fff;border:1px solid #555;padding:4px 10px;
         cursor:pointer;border-radius:4px;font-size:12px}
  .tip{margin-top:20px;padding:12px 16px;background:#1a2a1a;border:1px solid #3a5a3a;
       border-radius:8px;font-size:13px;color:#afa;line-height:1.8}
</style></head><body>
<h1>📡 OXAX Relay</h1>
<div class="info">
  <b>Como usar no VLC/IPTV:</b><br>
  1. Abra o <b>Player Web</b> de um canal no seu browser (extrai o token automaticamente)<br>
  2. Após carregar, o link M3U8 funciona no VLC por <b>25 minutos</b><br>
  3. Playlist: <a href="${host}/playlist.m3u">${host}/playlist.m3u</a>
</div>
<table>
  <thead><tr><th>Canal</th><th>Player</th><th>M3U8 (link fixo)</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="tip">
  💡 <b>Dica:</b> Abra o player web de cada canal no browser primeiro.
  O token fica ativo por 25 min e o VLC funciona durante esse período.
  Quando expirar, abra o player web novamente.
</div>
<script>
  function cp(t,b){navigator.clipboard.writeText(t);b.textContent='✅';setTimeout(()=>b.textContent='📋',2000)}
  setInterval(() => location.reload(), 60000); // atualiza status a cada 1min
</script>
</body></html>`);
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get('/admin/refresh/:slug', (req, res) => {
  delete tokens[req.params.slug];
  res.json({ ok: true });
});

app.get('/admin/tokens', (_, res) => {
  const now = Date.now();
  res.json(Object.entries(tokens).map(([slug, v]) => ({
    slug, m3u8Url: v.m3u8Url,
    age: Math.round((now - v.ts) / 60000) + 'min',
    valid: hasValidToken(slug),
  })));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  let extIP = '0.0.0.0';
  Object.values(ifaces).flat().forEach(i => {
    if (i && i.family === 'IPv4' && !i.internal) extIP = i.address;
  });
  console.log(`\n🚀  OXAX Relay v4 iniciado!`);
  console.log(`   Local:    http://localhost:${PORT}/`);
  console.log(`   Rede:     http://${extIP}:${PORT}/`);
  console.log(`   Playlist: http://${extIP}:${PORT}/playlist.m3u`);
  console.log(`\n   📖 Como usar:`);
  console.log(`      1. Abra http://${extIP}:${PORT}/canal/brazzers-tv-europe no browser`);
  console.log(`      2. O token é registrado automaticamente`);
  console.log(`      3. Use http://${extIP}:${PORT}/stream/brazzers-tv-europe.m3u8 no VLC\n`);
});