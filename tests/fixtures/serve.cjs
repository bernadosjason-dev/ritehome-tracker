// Serves the repository on http://127.0.0.1:8000 the way Vercel serves portal.ritehomemodular.com:
// files first, then vercel.json redirects and rewrites, and nothing listed in .vercelignore. The
// browser tests run against this, so the short addresses (/, /projects, /fuel, /accounting) are
// tested with the same rules the live site uses.
//
//   node tests/fixtures/serve.cjs            (leave running, then run the browser tests)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8000);
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const ignored = new Set(fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => '/' + l.replace(/^\//, '')));
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8'};

// Vercel source patterns used in vercel.json: literal paths and /:name(a|b|c).
function matches(source, pathname){
  const re = new RegExp('^' + source.replace(/:\w+\(([^)]+)\)/g, '($1)').replace(/\//g, '\\/') + '$');
  return re.test(pathname);
}
function fileFor(pathname){
  if(ignored.has(pathname)) return null;
  const file = path.join(ROOT, decodeURIComponent(pathname));
  if(!file.startsWith(ROOT + path.sep)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch(e){ return null; }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (config.trailingSlash === false && url.pathname.length > 1 && url.pathname.endsWith('/')) {
    res.writeHead(308, {Location: url.pathname.replace(/\/+$/, '') + url.search}); return res.end();
  }
  for (const r of config.redirects || []) {
    if (matches(r.source, url.pathname)) { res.writeHead(r.permanent ? 308 : 307, {Location: r.destination + url.search}); return res.end(); }
  }
  let file = fileFor(url.pathname);                         // the filesystem wins, as on Vercel
  if (!file) for (const r of config.rewrites || []) {
    if (matches(r.source, url.pathname)) { file = fileFor(r.destination); break; }
  }
  if (!file) { res.writeHead(404, {'Content-Type': 'text/plain'}); return res.end('Not found'); }
  res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('Serving ' + ROOT + ' like Vercel on http://127.0.0.1:' + PORT));
