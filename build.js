const fs = require('fs');

const src = fs.readFileSync('worker.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');

// Escape for template literal embedding
const escaped = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

// Find and replace the INDEX_HTML assignment
const pattern = /var INDEX_HTML = `[\s\S]*?`;\n/;
const replacement = 'var INDEX_HTML = `' + escaped + '`;\n';
const output = src.replace(pattern, replacement);

if (output === src) {
  console.error('ERROR: regex did not match - check INDEX_HTML format');
  process.exit(1);
}

fs.writeFileSync('worker.js', output);
console.log('Built worker.js:', output.length, 'bytes');
