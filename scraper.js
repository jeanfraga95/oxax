/**
 * scraper.js - Descobre todos os canais do oxax.tv automaticamente
 * 
 * Uso: node scraper.js
 * 
 * Vai listar todos os canais encontrados e gerar o código
 * pronto para copiar no server.js (objeto CHANNELS)
 */

const axios      = require('axios');
const https      = require('https');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://oxax.tv/',
};

async function getChannelList() {
  console.log('🔍 Buscando lista de canais no oxax.tv...\n');

  // O site carrega a lista via AJAX: GET /spisok
  const res = await axios.get('https://oxax.tv/spisok', { headers: HEADERS, timeout: 15000, httpsAgent });
  const html = res.data;

  // Extrai todos os hrefs de canais
  const matches = [...html.matchAll(/href="\/([^"]+\.html)"/g)];
  const channels = {};

  for (const m of matches) {
    const path = m[1]; // ex: brazzers-tv-europe.html
    const slug = path.replace('.html', ''); // brazzers-tv-europe
    if (!slug.includes('porno-kanaly') && !slug.includes('hd-kanaly') && 
        !slug.includes('erotic-tv') && !slug.includes('kontact') && slug !== '') {
      channels[slug] = `https://oxax.tv/${path}`;
    }
  }

  return channels;
}

async function extractM3U8(channelUrl, slug) {
  try {
    const response = await axios.get(channelUrl, { headers: HEADERS, timeout: 10000, httpsAgent });
    const html = response.data;

    const kodkMatch = html.match(/var\s+kodk\s*=\s*"([^"]+)"/);
    if (!kodkMatch) return null;

    const kodk = kodkMatch[1];
    
    // Tenta extrair base do player
    const playerMatch = html.match(/new Playerjs\("([^"]+)"\)/);
    let streamBase = 'https://s.oxax.tv/';
    
    if (playerMatch) {
      try {
        const decoded = Buffer.from(playerMatch[1], 'base64').toString('utf-8');
        const urlMatch = decoded.match(/"file"\s*:\s*"(https?:\/\/[^"]+)"/);
        if (urlMatch) streamBase = urlMatch[1].split('{v1}')[0];
      } catch (e) {}
    }

    return `${streamBase}${kodk}`;
  } catch (e) {
    return null;
  }
}

async function main() {
  const channels = await getChannelList();
  const slugs = Object.keys(channels);

  console.log(`✅ ${slugs.length} canais encontrados:\n`);

  const result = [];

  for (const [slug, url] of Object.entries(channels)) {
    const name = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    console.log(`  🔎 ${name} ...`);
    const m3u8 = await extractM3U8(url, slug);
    result.push({ slug, url, m3u8, name });
    
    // Delay para não sobrecarregar
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n\n' + '='.repeat(60));
  console.log('📋 COLE ISSO NO server.js (substitui o objeto CHANNELS):');
  console.log('='.repeat(60) + '\n');

  console.log('const CHANNELS = {');
  for (const { slug, url } of result) {
    console.log(`  '${slug}': '${url}',`);
  }
  console.log('};\n');

  console.log('='.repeat(60));
  console.log('📺 M3U8s encontrados agora:');
  console.log('='.repeat(60) + '\n');

  for (const { name, m3u8 } of result) {
    if (m3u8) {
      console.log(`✅ ${name}`);
      console.log(`   ${m3u8}\n`);
    } else {
      console.log(`❌ ${name} - não foi possível extrair m3u8\n`);
    }
  }

  // Salva em arquivo
  const fs = require('fs');
  const output = {
    timestamp: new Date().toISOString(),
    channels: result,
  };
  fs.writeFileSync('channels_discovered.json', JSON.stringify(output, null, 2));
  console.log('\n💾 Resultado salvo em channels_discovered.json');
}

main().catch(console.error);
