/**
 * OXAX.TV Channel Relay Server v3
 *
 * Usa puppeteer-core + chromium headless para:
 *  1. Abrir a página do canal como navegador real (bypassa bloqueio de VPS)
 *  2. Interceptar a requisição m3u8 e capturar a URL real + cookies
 *  3. Fazer proxy completo dos chunks .ts para VLC/IPTV
 *
 * Instalação: ver install.sh
 */

'use strict';

const express  = require('express');
const axios    = require('axios');
const https    = require('https');
const puppeteer = require('puppeteer-core');

const app  = express();
const PORT = process.env.PORT || 3000;

// Caminho do chromium instalado via apt
const CHROMIUM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/snap/bin/chromium',
];

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ── Mapa de canais ─────────────────────────────────────────────────────────────
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

// ── Cache (slug → {m3u8Url, cookies, ts}) ─────────────────────────────────────
const cache    = {};
const CACHE_TTL = 25 * 60 * 1000; // 25 min

// ── Encontra o chromium instalado ─────────────────────────────────────────────
function findChromium() {
  const fs = require('fs');
  for (const p of CHROMIUM_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'Chromium não encontrado. Execute:\n  sudo apt-get install -y chromium-browser\nou\n  sudo apt-get install -y chromium'
  );
}

// ── Usa puppeteer para abrir a página e capturar a URL do m3u8 ────────────────
async function extractViaHeadless(channelUrl) {
  const executablePath = findChromium();
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
      ],
    });

    const page = await browser.newPage();

    // Configura como Chrome real
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
    });

    // Intercepta requisições para capturar m3u8
    let capturedM3U8 = null;
    let capturedCookies = '';

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      // Captura a primeira requisição .m3u8 que não seja da própria página
      if (!capturedM3U8 && url.includes('.m3u8')) {
        capturedM3U8 = url;
        capturedCookies = req.headers()['cookie'] || '';
      }
      req.continue();
    });

    // Abre a página e clica no play (se necessário)
    await page.goto(channelUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Aguarda até 15s pelo m3u8 aparecer
    let waited = 0;
    while (!capturedM3U8 && waited < 15000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }

    // Fallback: extrai kodk do HTML se não capturou via interceptação
    if (!capturedM3U8) {
      const html = await page.content();
      const kodkMatch = html.match(/var\s+kodk\s*=\s*["']([^"']+)["']/);
      const kosMatch  = html.match(/var\s+kos\s*=\s*["']([^"']+)["']/);
      if (kodkMatch) {
        const kodk = kodkMatch[1];
        const kos  = kosMatch ? kosMatch[1] : '';
        // Tenta montar URL — extrai hash do canal do playerjs
        let hash = '';
        const pjMatch = html.match(/new\s+Playerjs\s*\(\s*["']#?([A-Za-z0-9+/=]+)["']\s*\)/);
        if (pjMatch) {
          try {
            const dec = Buffer.from(pjMatch[1], 'base64').toString('utf-8');
            const fm  = dec.match(/s\.oxax\.tv\/(?:\{v1\})?([a-z0-9]+)(?:\{v2\})?/);
            if (fm) hash = fm[1];
          } catch (_) {}
        }
        const mid = Math.floor(kos.length / 2);
        const base = hash && kos
          ? `https://s.oxax.tv/${kos.slice(0,mid)}${hash}${kos.slice(mid)}/`
          : 'https://s.oxax.tv/';
        capturedM3U8 = base + kodk;
      }
    }

    if (!capturedM3U8) throw new Error('Não foi possível capturar o m3u8');

    // Pega cookies da página para usar no proxy
    const pageCookies = await page.cookies();
    const cookieStr   = pageCookies.map(c => `${c.name}=${c.value}`).join('; ');

    return { m3u8Url: capturedM3U8, cookies: cookieStr || capturedCookies };

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function getCached(slug) {
  const now = Date.now();
  if (cache[slug] && (now - cache[slug].ts) < CACHE_TTL) return cache[slug];
  console.log(`[cache] atualizando ${slug}...`);
  const data = await extractViaHeadless(CHANNELS[slug]);
  cache[slug] = { ...data, ts: now };
  console.log(`[cache] ${slug} → ${data.m3u8Url}`);
  return cache[slug];
}

// ── Headers para requisições ao stream ────────────────────────────────────────
function streamHeaders(cookies) {
  return {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer'        : 'https://oxax.tv/',
    'Origin'         : 'https://oxax.tv',
    'Accept'         : '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection'     : 'keep-alive',
    ...(cookies ? { 'Cookie': cookies } : {}),
  };
}

// ── CORS ───────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ── /stream/:slug.m3u8 — M3U8 com proxy de segmentos ─────────────────────────
app.get('/stream/:slug.m3u8', async (req, res) => {
  const slug = req.params.slug;
  if (!CHANNELS[slug]) return res.status(404).send('Canal não encontrado');

  try {
    const { m3u8Url, cookies } = await getCached(slug);
    const host = `${req.protocol}://${req.get('host')}`;

    const m3u8Resp = await axios.get(m3u8Url, {
      headers: streamHeaders(cookies),
      httpsAgent,
      timeout: 15000,
    });

    let content = m3u8Resp.data;
    const baseDir = m3u8Url.replace(/\/[^/?]+\.m3u8.*$/, '/');

    // Reescreve segmentos para passar pelo proxy
    content = content.replace(/^([^#\n][^\n]*)$/gm, (line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      const absUrl = trimmed.startsWith('http') ? trimmed : baseDir + trimmed;
      return `${host}/proxy-ts?url=${encodeURIComponent(absUrl)}&slug=${slug}`;
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(content);

  } catch (err) {
    console.error(`[stream/${slug}]`, err.message);
    delete cache[slug];
    res.status(502).send(`Erro ao obter stream: ${err.message}`);
  }
});

// ── /proxy-ts — Proxy de segmentos .ts ────────────────────────────────────────
app.get('/proxy-ts', async (req, res) => {
  const tsUrl = decodeURIComponent(req.query.url || '');
  const slug  = req.query.slug || '';

  if (!tsUrl.startsWith('https://s.oxax.tv/') && !tsUrl.startsWith('https://r.pokaz.me/')) {
    return res.status(400).send('URL inválida');
  }

  try {
    const cookies = cache[slug]?.cookies || '';
    const upstream = await axios.get(tsUrl, {
      headers: streamHeaders(cookies),
      httpsAgent,
      responseType: 'stream',
      timeout: 20000,
    });
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/MP2T');
    res.setHeader('Access-Control-Allow-Origin', '*');
    upstream.data.pipe(res);
  } catch (err) {
    console.error(`[proxy-ts]`, err.message);
    res.status(502).send('Erro proxy');
  }
});

// ── /playlist.m3u ─────────────────────────────────────────────────────────────
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

// ── /api/m3u8/:slug — debug ────────────────────────────────────────────────────
app.get('/api/m3u8/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!CHANNELS[slug]) return res.status(404).json({ error: 'não encontrado' });
  try {
    const info = await getCached(slug);
    res.json({ slug, m3u8Url: info.m3u8Url, hasCookies: !!info.cookies });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── /canal/:slug — Player web ──────────────────────────────────────────────────
app.get('/canal/:slug', (req, res) => {
  const { slug } = req.params;
  if (!CHANNELS[slug]) return res.status(404).send('Canal não encontrado. <a href="/">Voltar</a>');
  const host = `${req.protocol}://${req.get('host')}`;
  const name = slug.replace(/-/g,' ').replace(/\b\w/g, l => l.toUpperCase());
  const src  = `${host}/stream/${slug}.m3u8`;

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${name}</title>
  <link href="https://vjs.zencdn.net/8.6.0/video-js.css" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000}
  .hdr{padding:10px 18px;background:#111;display:flex;align-items:center;gap:14px}
  .hdr a{color:#f90;text-decoration:none;font-size:13px}
  .hdr h2{font-size:15px;flex:1;color:#fff}
  #vp{width:100%;height:calc(100vh - 44px)}</style>
</head><body>
  <div class="hdr"><a href="/">← Canais</a><h2>📺 ${name}</h2></div>
  <video id="vp" class="video-js vjs-big-play-centered" controls preload="auto" autoplay></video>
  <script src="https://vjs.zencdn.net/8.6.0/video.min.js"></script>
  <script>
    var pl = videojs('vp', {fill:true});
    pl.src({type:'application/x-mpegURL', src:'${src}'});
    pl.play();
  </script>
</body></html>`);
});

// ── / — Lista de canais ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  const rows = Object.entries(CHANNELS).map(([slug]) => {
    const name = slug.replace(/-/g,' ').replace(/\b\w/g, l => l.toUpperCase());
    const m3u8 = `${host}/stream/${slug}.m3u8`;
    const cached = !!cache[slug];
    return `<tr>
      <td><b>${name}</b> ${cached ? '<span style="color:#6f6;font-size:11px">● cache</span>' : ''}</td>
      <td><a href="${host}/canal/${slug}" target="_blank">▶ Player</a></td>
      <td><a href="${m3u8}">${m3u8}</a></td>
      <td><button onclick="cp('${m3u8}',this)">📋</button></td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OXAX Relay</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}
  body{font-family:sans-serif;background:#111;color:#eee;padding:20px}
  h1{color:#f90;margin-bottom:8px}
  .info{background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:14px 18px;margin-bottom:22px;font-size:13px;line-height:1.9}
  .info a,.info code{color:#6af}.info code{background:#000;padding:2px 6px;border-radius:3px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#f90;color:#000;padding:8px 12px;text-align:left}
  td{padding:7px 12px;border-bottom:1px solid #333;vertical-align:middle}
  tr:hover td{background:#1a1a1a}a{color:#6af;text-decoration:none;word-break:break-all}
  button{background:#333;color:#fff;border:1px solid #555;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:12px}
  </style></head><body>
  <h1>📡 OXAX Relay</h1>
  <div class="info">
    Proxy completo via Chromium headless — funciona no VLC, Kodi e qualquer IPTV player.<br>
    • <b>Playlist:</b> <a href="${host}/playlist.m3u">${host}/playlist.m3u</a><br>
    • <b>M3U8:</b> <code>${host}/stream/{slug}.m3u8</code><br>
    • Primeiro acesso a cada canal demora ~10s (abre browser headless). Depois: cache de 25min.
  </div>
  <table>
    <thead><tr><th>Canal</th><th>Player</th><th>M3U8 (link fixo)</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>function cp(t,b){navigator.clipboard.writeText(t);b.textContent='✅';setTimeout(()=>b.textContent='📋',2000)}</script>
</body></html>`);
});

// ── Admin ──────────────────────────────────────────────────────────────────────
app.get('/admin/refresh/:slug', (req, res) => {
  delete cache[req.params.slug];
  res.json({ ok: true, msg: `Cache de "${req.params.slug}" limpo` });
});

app.get('/admin/cache', (_, res) => {
  const now = Date.now();
  res.json(Object.entries(cache).map(([slug, v]) => ({
    slug,
    m3u8Url: v.m3u8Url,
    age: Math.round((now - v.ts) / 60000) + 'min',
    expires: Math.round((CACHE_TTL - (now - v.ts)) / 60000) + 'min',
  })));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  let extIP = '0.0.0.0';
  Object.values(ifaces).flat().forEach(i => {
    if (i && i.family === 'IPv4' && !i.internal) extIP = i.address;
  });
  console.log(`\n🚀  OXAX Relay v3 iniciado!`);
  console.log(`   Local:    http://localhost:${PORT}/`);
  console.log(`   Rede:     http://${extIP}:${PORT}/`);
  console.log(`   Playlist: http://${extIP}:${PORT}/playlist.m3u`);
  console.log(`\n   ⚡ Primeiro acesso a cada canal abre chromium headless (~10s)`);
  console.log(`   💡 Chromium: ${(() => { try { return require('fs').existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : require('fs').existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'não encontrado' } catch(e){return 'erro'} })()}\n`);
});
