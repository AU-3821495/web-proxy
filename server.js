import express from 'express';
import { fetch } from 'undici';
import morgan from 'morgan';
import HttpProxy from 'http-proxy';
import cheerio from 'cheerio';
import { pipeline } from 'stream';
import { promisify } from 'util';
const app = express();
const pipe = promisify(pipeline);

// Basic config
const PORT = process.env.PORT || 10000;
const MAX_BODY_MB = parseInt(process.env.MAX_BODY_MB || '64', 10); // streaming, but guard POST
const ALLOWLIST = (process.env.ALLOWLIST || '').split(',').filter(Boolean); // e.g. "example.com,*.edu"
const BLOCKLIST = (process.env.BLOCKLIST || '').split(',').filter(Boolean);
const ENABLE_REWRITE = process.env.ENABLE_REWRITE !== 'false'; // HTML rewrite on/off

// Logging (minimal for education mode)
app.use(morgan('tiny'));

// CORS for browser->proxy
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Static front
app.use(express.static('public'));

// Helpers
function matchesList(host, list) {
  if (!host) return false;
  return list.some(rule => {
    if (rule.startsWith('*.')) {
      return host.endsWith(rule.slice(1));
    }
    return host === rule;
  });
}

function isAllowed(urlObj) {
  const host = urlObj.hostname;
  if (BLOCKLIST.length && matchesList(host, BLOCKLIST)) return false;
  if (ALLOWLIST.length && !matchesList(host, ALLOWLIST)) return false;
  return true;
}

function absoluteUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function toProxyUrl(targetUrl) {
  const u = new URL(targetUrl);
  return `/proxy?url=${encodeURIComponent(u.toString())}`;
}

// Proxy core
app.all('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing ?url=');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return res.status(400).send('Invalid URL');
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return res.status(400).send('Only http/https are supported');
  }

  if (!isAllowed(targetUrl)) {
    return res.status(403).send('Blocked by policy');
  }

  // Build request options
  const headers = { ...req.headers };
  // Remove hop-by-hop and browser-specific headers
  delete headers['host'];
  delete headers['origin'];
  delete headers['referer'];
  delete headers['accept-encoding']; // avoid gzip double handling; undici negotiates
  // Optional: set UA to a stable string
  headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (ProxyRender/1.0)';

  // Method and body handling
  const method = req.method;
  let body = undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    // Guard size
    let chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_MB * 1024 * 1024) {
        return res.status(413).send('Payload too large');
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method,
      headers,
      body,
      redirect: 'manual'
    });
  } catch (e) {
    return res.status(502).send('Upstream fetch failed');
  }

  // Mirror status
  res.status(upstream.status);

  // Copy selective headers
  const hopByHop = new Set([
    'connection','keep-alive','proxy-authenticate','proxy-authorization',
    'te','trailers','transfer-encoding','upgrade'
  ]);
  for (const [k, v] of upstream.headers) {
    if (hopByHop.has(k.toLowerCase())) continue;
    // Prevent framing issues? We cannot override target's X-Frame-Options/CSP effectively for iframe embedding,
    // but we can avoid sending them to browser to reduce conflicts for same-origin framing scenarios.
    if (['x-frame-options','content-security-policy','content-security-policy-report-only'].includes(k.toLowerCase())) continue;
    res.setHeader(k, v);
  }

  // Handle redirects: rewrite Location to go through proxy
  const location = upstream.headers.get('location');
  if (location) {
    const abs = absoluteUrl(targetUrl, location);
    if (abs) res.setHeader('Location', toProxyUrl(abs));
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isHtml = contentType.startsWith('text/html');

  // Stream non-HTML as-is (videos, images, etc.)
  if (!isHtml || !ENABLE_REWRITE) {
    // Support Range pass-through already by forwarding headers; undici streams response
    return pipe(upstream.body, res).catch(() => res.end());
  }

  // HTML rewrite: fix links/scripts/images/forms to continue via proxy
  const htmlText = await upstream.text();
  const $ = cheerio.load(htmlText);

  // <base> to make relative resolution predictable
  $('head').prepend(`<base href="${targetUrl.toString()}">`);

  // Rewrite links
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const abs = absoluteUrl(targetUrl, href);
    if (abs) $(el).attr('href', toProxyUrl(abs));
  });

  // Rewrite resources
  ['src','href'].forEach(attr => {
    $('img,script,link,source,video,audio').each((_, el) => {
      const val = $(el).attr(attr);
      if (!val) return;
      const abs = absoluteUrl(targetUrl, val);
      if (abs) $(el).attr(attr, toProxyUrl(abs));
    });
  });

  // Rewrite forms (action)
  $('form[action]').each((_, el) => {
    const action = $(el).attr('action');
    const abs = absoluteUrl(targetUrl, action);
    if (abs) $(el).attr('action', toProxyUrl(abs));
    // Method stays as-is; enctype respected
  });

  // Inject a small script to catch dynamic navigations
  $('head').append(`
    <script>
    (function(){
      const toProxy = u => '/proxy?url=' + encodeURIComponent(new URL(u, document.baseURI).toString());
      document.addEventListener('click', function(e){
        const a = e.target.closest('a[href]');
        if (a && !a.target) {
          e.preventDefault();
          location.href = toProxy(a.href);
        }
      }, true);
      // Intercept fetch/XHR navigations lightly (best effort)
      const origFetch = window.fetch;
      window.fetch = function(input, init){
        try {
          const url = typeof input === 'string' ? input : input.url;
          const abs = new URL(url, document.baseURI).toString();
          return origFetch(toProxy(abs), init);
        } catch {
          return origFetch(input, init);
        }
      };
    })();
    </script>
  `);

  const out = $.html();
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(out);
});

// WebSocket bridge (basic)
// Note: Many sites use WS via same origin paths; this demo maps /ws?url=...
const proxy = HttpProxy.createProxyServer({ ws: true, changeOrigin: true });
app.get('/ws', (req, res) => res.status(400).send('Use WebSocket upgrade'));

const server = app.listen(PORT, () => {
  console.log('Proxy listening on ' + PORT);
});

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const target = url.searchParams.get('url');
    if (!target) return socket.destroy();
    const targetUrl = new URL(target);
    if (!isAllowed(targetUrl)) return socket.destroy();
    proxy.ws(req, socket, head, { target: targetUrl.origin });
  } catch {
    socket.destroy();
  }
});
