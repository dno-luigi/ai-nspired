const fs = require('fs');

const servedHtml = fs.readFileSync('/tmp/tew/served-working.html', 'utf8');
const src = fs.readFileSync('/tmp/tew/worker-clean.mjs', 'utf8');

const marker = 'var INDEX_HTML = `';
const start = src.indexOf(marker);

const before = src.substring(0, start);

const afterMarker = '\nvar server_default';
const afterIdx = src.indexOf(afterMarker);
const after = src.substring(afterIdx);

// Escape backticks and template vars for use in template literal
const escaped = servedHtml.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const newSrc = before + 'var INDEX_HTML = `' + escaped + '`' + after;

fs.writeFileSync('/tmp/tew/worker-clean.mjs', newSrc);
console.log('Rebuilt. Total size:', newSrc.length);

// Count backticks in the escaped content
let count = 0;
for (let i = 0; i < escaped.length; i++) {
  if (escaped[i] === '`') count++;
}
console.log('Backticks in escaped INDEX_HTML:', count);

// Verify the template evaluates correctly by evaluating a mini test
try {
  const test = new Function('return `' + escaped.substring(0, 500) + '`');
  const result = test();
  console.log('Template eval test OK, first 80:', result.substring(0, 80));
} catch(e) {
  console.log('Template eval FAILED:', e.message);
}
