#!/usr/bin/env node
// Turns a raw saved page into a committed fixture: drops page scripts (keeps JSON-LD), styles and
// noscript, and redacts reviewer names, profile links and session tokens so no personal or
// session data is stored. Usage:
//   node fixtures/pages/tools/sanitize.mjs <raw.html> <out.html> <source-url>
import fs from 'node:fs';

const [rawPath, outPath, url] = process.argv.slice(2);
if (!rawPath || !outPath || !url) {
  console.error('usage: sanitize.mjs <raw.html> <out.html> <source-url>');
  process.exit(2);
}

let html = fs.readFileSync(rawPath, 'utf8');

// Scripts: keep JSON-LD only, with reviewer names replaced.
html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_m, attrs, body) => {
  if (!/application\/ld\+json/i.test(attrs)) return '';
  return `<script${attrs}>${redactJsonLd(body)}</script>`;
});
html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
html = html.replace(/<link\b[^>]*rel="?(?:stylesheet|preload|prefetch|dns-prefetch|preconnect)"?[^>]*>/gi, '');
html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');

// Reviewer identity (Amazon).
html = html.replace(
  /(<span class="a-profile-name"[^>]*>)[^<]*(<\/span>)/g,
  '$1A reviewer$2',
);
html = html.replace(/\/gp\/profile\/amzn1\.account\.[A-Z0-9]+/g, '/gp/profile/REDACTED');

// Session / CSRF / tracking tokens in hidden inputs and data attributes.
html = html.replace(
  /(<input\b[^>]*(?:name|id)="[^"]*(?:session|csrf|token|ue_sid|sid)[^"]*"[^>]*value=")[^"]*(")/gi,
  '$1REDACTED$2',
);
html = html.replace(/(\sdata-[\w-]*(?:csrf|token)[\w-]*=")[^"]*(")/gi, '$1REDACTED$2');
html = html.replace(
  /((?:&quot;|")[\w-]*(?:csrf|token)[\w-]*(?:&quot;|")\s*:\s*(?:&quot;|"))[^&"]+/gi,
  '$1REDACTED',
);
html = html.replace(/(session-id[=:]["']?)[0-9-]{10,}/gi, '$1REDACTED');
html = html.replace(/(ue_sid\s*=\s*['"])[^'"]+/g, '$1REDACTED');

// Collapse runs of blank lines left by the removals.
html = html.replace(/\n\s*\n+/g, '\n');

const header = `<!-- fixture: saved from ${url} on ${new Date().toISOString().slice(0, 10)}; sanitised by fixtures/pages/tools/sanitize.mjs -->\n`;
fs.writeFileSync(outPath, header + html);
console.log(`${outPath}: ${(fs.statSync(outPath).size / 1024).toFixed(0)} KiB`);

function redactJsonLd(body) {
  try {
    const data = JSON.parse(body);
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (node['@type'] === 'Person' && 'name' in node) node.name = 'A reviewer';
      Object.values(node).forEach(walk);
    };
    walk(data);
    return JSON.stringify(data);
  } catch {
    return body;
  }
}
