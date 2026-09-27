// Shared bits for the headless tools: a tiny static server for mv/ and a
// Playwright page with the player loaded and ready.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.css': 'text/css' };

function serve() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(p.endsWith('/') ? p + 'index.html' : p, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }).end(data);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function openPlayer({ query = '' } = {}) {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { throw new Error('playwright not found: run `npm install` in mv/tools (or set NODE_PATH=$(npm root -g))'); }
  const server = await serve();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', e => console.error('[page]', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html${query}`);
  await page.evaluate(() => window.MV.ready);
  return { page, close: async () => { await browser.close(); server.close(); } };
}

module.exports = { openPlayer };
