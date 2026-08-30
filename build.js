#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Escape for template literal
const escaped = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

// Find INDEX_HTML boundaries by character position
const idx = src.indexOf('var INDEX_HTML');
const openPos = src.indexOf('`', idx);

// Find matching close
let pos = openPos + 1;
while (pos < src.length) {
  if (src[pos] === '\\') { pos += 2; continue; }
  if (src[pos] === '`') break;
  pos++;
}

const before = src.substring(0, openPos + 1);
const after = src.substring(pos);
const output = before + escaped + after;

fs.writeFileSync(path.join(__dirname, 'worker.js'), output);
console.log(`Built worker.js: ${output.length} bytes (HTML: ${html.length} → escaped: ${escaped.length})`);
