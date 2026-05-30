/**
 * OXAX.TV Channel Relay Server
 * Links fixos para cada canal - redireciona automaticamente para o m3u8 atual
 *
 * Como funciona:
 * 1. Cada canal tem um slug fixo  (ex: /canal/brazzers-tv-europe)
 * 2. Ao acessar /stream/slug.m3u8 o servidor busca a página do canal no oxax.tv,
 *    extrai o token `kodk` do JS inline e redireciona para o stream real.
 * 3. Cache de 30 min evita bater no oxax.tv a cada request.
 */

const express = require('express');
const axios   = require('axios');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ============================================================
// MAPA DE CANAIS  slug-fixo => URL da página no oxax.tv
// Descubra novos canais com:  node scraper.js
// ============================================================
const CHANNELS = {
  // — Pornô —
  'brazzers-tv-europe'  : 'https://oxax.tv/brazzers-tv-europe.html',
  'private-tv'          : 'https://oxax.tv/private-tv.html',
  'penthouse-tv'        : 'https://oxax.tv/penthouse-tv.html',
  'vivid-tv'            : 'https://oxax.tv/vivid-tv.html',
  'playboy-tv'          : 'https://oxax.tv/playboy-tv.html',
  'hustler-tv'          : 'https://oxax.tv/hustler-tv.html',
  'reality-kings-tv'    : 'https://oxax.tv/reality-kings-tv.html',
  'mia-tv'              : 'https://oxax.tv/mia-tv.html',
  'dorcel-tv'           : 'https://oxax.tv/dorcel-tv.html',
  'club-clipz'          : 'https://oxax.tv/club-clipz.html',
  'private-spice-hd'    : 'https://oxax.tv/private-spice-hd.html',
  // — Erótico —
  'erox-tv'             : 'https://oxax.tv/erox-tv.html',
  'pink-erotic'         : 'https://oxax.tv/pink-erotic.html',
  'erotic-travel'       : 'https://oxax.tv/erotic-travel.html',
};

// ============================================================
// Cache  (slug → { m3u8Url, ts })
// ============================================================
const cache    = {};
const CACHE_TTL = 30 * 60 * 1000;   // 30 minutos

const HEADERS = {
  'User-Agent' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer'    : 'https://oxax.tv/',
  'Accept'     : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

// ============================================================
// Extrai a URL m3u8 atual da página de um canal
// ============================================================
async function extractM3U8(channelUrl) {
  const resp = await axios.get(channelUrl, { headers: HEADERS, timeout: 12000 });
  const html = resp.data;

  // var kodk="2/index.m3u8?k=TOKEN";
  const kodkMatch = html.match(/var\s+kodk\s*=\s*["']([^"']+)["']/);
  if (!kodkMatch) throw new Error('kodk não encontrado na página');

  const kodk = kodkMatch[1];   // ex: "2/index.m3u8?k=1780165955p771i..."

  // Tenta extrair a base correta do Playerjs (base64 no argumento do construtor)
  let streamBase = 'https://s.oxax.tv/';
  const pjMatch  = html.match(/new\s+Playerjs\s*\(\s*["']([^"']+)["']\s*\)/);
  if (pjMatch) {
    try {
      const raw  = pjMatch[1].replace(/^#/, '');
      const json = Buffer.from(raw, 'base64').toString('utf-8');
      // {"id":"pl_ok","file":"https://s.oxax.tv/{v1}HASH{v2}..."}
      const fm = json.match(/"file"\s*:\s*"(https?:\/\/[^"]+)"/);
      if (fm) {
        const base = fm[1].split('{v1}')[0];   // tudo antes do placeholder
        if (base.startsWith('http')) streamBase = base;
      }
    } catch (_) { /* usa o default */ }
  }

  const m3u8Url = `${streamBase}${kodk}`;
  return m3u8Url;
}

async function getCached(slug) {
  const now = Date.now();
  if (cache[slug] && (now - cache[slug].ts) < CACHE_TTL) return cache[slug].url;
  const url = await extractM3U8(CHANNELS[slug]);
  cache[slug] = { url, ts: now };
  return url;
}

// ============================================================
// MIDDLEWARES
// ============================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ============================================================
// ROTA: Página inicial — lista de canais
// ============================================================
app.get('/', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  const rows = Object.entries(CHANNELS).map(([slug]) => {
    const name  = slug.replace(/-/g,' ').replace(/\b\w/g, l => l.toUpperCase());
    const player = `${host}/canal/${slug}`;
    const m3u8   = `${host}/stream/${slug}.m3u8`;
    return `<tr>
      <td><b>${name}</b></td>
      <td><a href="${player}" target="_blank">${player}</a></td>
      <td><a href="${m3u8}"  target="_blank">${m3u8}</a></td>
      <td><button onclick="cp('${m3u8}',this)">📋</button></td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OXAX Relay</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:sans-serif;background:#111;color:#eee;padding:20px}
    h1{color:#f90;margin-bottom:8px}
    .info{background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:14px 18px;
          margin-bottom:22px;font-size:13px;line-height:1.9}
    .info code{background:#000;padding:2px 6px;border-radius:3px;color:#6af}
    .info a{color:#6af}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{background:#f90;color:#000;padding:8px 12px;text-align:left}
    td{padding:7px 12px;border-bottom:1px solid #333;vertical-align:middle}
    tr:hover td{background:#1a1a1a}
    a{color:#6af;text-decoration:none;word-break:break-all}
    a:hover{text-decoration:underline}
    button{background:#333;color:#fff;border:1px solid #555;padding:4px 10px;
           cursor:pointer;border-radius:4px;font-size:12px}
    button:hover{background:#555}
  </style></head><body>
  <h1>📡 OXAX Relay — Links Fixos</h1>
  <div class="info">
    <b>Links fixos</b> que nunca mudam — mesmo quando o oxax.tv troca o m3u8.<br>
    • <b>Player:</b> <code>/canal/slug</code> &nbsp;|&nbsp;
      <b>M3U8 fixo:</b> <code>/stream/slug.m3u8</code> &nbsp;|&nbsp;
      <b>Playlist:</b> <a href="${host}/playlist.m3u">/playlist.m3u</a><br>
    • Cache automático de 30 min. Forçar atualização: <code>/admin/refresh/slug</code>
  </div>
  <table>
    <thead><tr><th>Canal</th><th>Player</th><th>M3U8 (link fixo)</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>
    function cp(t,btn){
      navigator.clipboard.writeText(t);
      btn.textContent='✅';
      setTimeout(()=>btn.textContent='📋',2000);
    }
  </script>
</body></html>`);
});

// ============================================================
// ROTA: Playlist M3U completa
// ============================================================
app.get('/playlist.m3u', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  let m3u = '#EXTM3U\n\n';
  for (const [slug] of Object.entries(CHANNELS)) {
    const name = slug.replace(/-/g,' ').replace(/\b\w/g, l => l.toUpperCase());
    m3u += `#EXTINF:-1 tvg-id="${slug}" tvg-name="${name}" group-title="OXAX",${name}\n`;
    m3u += `${host}/stream/${slug}.m3u8\n\n`;
  }
  res.setHeader('Content-Type', 'application/x-mpegURL');
  res.setHeader('Content-Disposition', 'attachment; filename="oxax.m3u"');
  res.send(m3u);
});

// ============================================================
// ROTA: Player embutido (video.js HLS)
// ============================================================
app.get('/canal/:slug', (req, res) => {
  const { slug } = req.params;
  if (!CHANNELS[slug]) return res.status(404).send('Canal não encontrado. <a href="/">Voltar</a>');

  const host  = `${req.protocol}://${req.get('host')}`;
  const name  = slug.replace(/-/g,' ').replace(/\b\w/g, l => l.toUpperCase());
  const fixed = `${host}/stream/${slug}.m3u8`;

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${name}</title>
  <link href="https://vjs.zencdn.net/8.6.0/video-js.css" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#000;color:#fff;font-family:sans-serif}
    .hdr{padding:10px 18px;background:#111;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
    .hdr a{color:#f90;text-decoration:none;font-size:13px}
    .hdr h2{font-size:15px;flex:1}
    .hdr small{color:#777;font-size:11px}
    .hdr small a{color:#6af}
    #vp{width:100%;height:calc(100vh - 46px)}
    .err{padding:20px;color:#f66;font-size:14px}
  </style>
</head><body>
  <div class="hdr">
    <a href="/">← Canais</a>
    <h2>📺 ${name}</h2>
    <small>Link fixo: <a href="${fixed}">${fixed}</a></small>
  </div>
  <video id="vp" class="video-js vjs-big-play-centered" controls preload="auto" autoplay></video>
  <script src="https://vjs.zencdn.net/8.6.0/video.min.js"></script>
  <script>
    var pl = videojs('vp', {fluid:false, fill:true});
    fetch('/api/m3u8/${slug}')
      .then(r => r.json())
      .then(d => {
        if (d.url) { pl.src({type:'application/x-mpegURL', src:d.url}); pl.play(); }
        else document.querySelector('#vp').insertAdjacentHTML('afterend',
          '<p class=err>Erro: ' + (d.error||'desconhecido') + '</p>');
      }).catch(e => console.error(e));
  </script>
</body></html>`);
});

// ============================================================
// ROTA: API JSON — URL m3u8 atual
// ============================================================
app.get('/api/m3u8/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!CHANNELS[slug]) return res.status(404).json({ error: 'Canal não encontrado' });
  try {
    const url = await getCached(slug);
    res.json({ slug, url });
  } catch (err) {
    console.error(`[${slug}] ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// ============================================================
// ROTA: Link fixo M3U8 → redirect para URL real
// ============================================================
app.get('/stream/:slug.m3u8', async (req, res) => {
  const slug = req.params.slug;
  if (!CHANNELS[slug]) return res.status(404).send('Canal não encontrado');
  try {
    const url = await getCached(slug);
    // Redirect 302 para o m3u8 real (muda a cada ~30min se necessário)
    res.redirect(302, url);
  } catch (err) {
    console.error(`[stream/${slug}] ${err.message}`);
    delete cache[slug];
    res.status(502).send(`Erro ao obter stream: ${err.message}`);
  }
});

// ============================================================
// ROTA: Admin — limpa cache / status
// ============================================================
app.get('/admin/refresh/:slug', (req, res) => {
  delete cache[req.params.slug];
  res.json({ ok: true, msg: `Cache de "${req.params.slug}" limpo` });
});

app.get('/admin/cache', (_req, res) => {
  const now = Date.now();
  res.json(Object.entries(cache).map(([slug, v]) => ({
    slug,
    url : v.url,
    age : Math.round((now - v.ts) / 60000) + ' min',
    ttl : Math.round((CACHE_TTL - (now - v.ts)) / 60000) + ' min',
  })));
});

// ============================================================
// Escuta em 0.0.0.0 para aceitar conexões externas (não só localhost)
app.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  let externalIP = '0.0.0.0';
  Object.values(ifaces).flat().forEach(i => {
    if (i.family === 'IPv4' && !i.internal) externalIP = i.address;
  });
  console.log(`\n🚀  OXAX Relay iniciado!`);
  console.log(`   Local:    http://localhost:${PORT}/`);
  console.log(`   Rede:     http://${externalIP}:${PORT}/`);
  console.log(`   Playlist: http://${externalIP}:${PORT}/playlist.m3u\n`);
});
