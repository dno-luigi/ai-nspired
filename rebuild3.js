const fs = require('fs');

const servedHtml = fs.readFileSync('/tmp/tew/served-working.html', 'utf8');
const src = fs.readFileSync('/tmp/tew/worker-clean.mjs', 'utf8');

const marker = 'var INDEX_HTML = `';
const start = src.indexOf(marker);
const before = src.substring(0, start);

const afterMarker = '\nvar server_default';
const afterIdx = src.indexOf(afterMarker);
const after = src.substring(afterIdx);

// Single-pass escape: \ → \\, ` → \`, ${ → \${
function escapeForTemplate(html) {
  let result = '';
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === '\\') {
      result += '\\\\';
    } else if (ch === '`') {
      result += '\\`';
    } else if (ch === '$' && i + 1 < html.length && html[i + 1] === '{') {
      result += '\\${';
      i++;
    } else {
      result += ch;
    }
  }
  return result;
}

const escaped = escapeForTemplate(servedHtml);
const newSrc = before + 'var INDEX_HTML = `' + escaped + '`' + after;

fs.writeFileSync('/tmp/tew/worker-clean.mjs', newSrc);
console.log('Rebuilt. Size:', newSrc.length);

// Verify
try {
  const test = new Function('return `' + escaped.substring(0, 2000) + '`');
  const result = test();
  // Count backticks in first 2000 chars of HTML
  const originalFirst2k = servedHtml.substring(0, 2000);
  const backticksOriginal = (originalFirst2k.match(/`/g) || []).length;
  const backticksResult = (result.match(/`/g) || []).length;
  console.log('Backticks in original first 2k:', backticksOriginal);
  console.log('Backticks in eval result first 2k:', backticksResult);
  console.log('Match:', backticksOriginal === backticksResult ? 'YES' : 'NO');
  // Check ${} too
  const origDollar = (originalFirst2k.match(/\$\{/g) || []).length;
  const resDollar = (result.match(/\$\{/g) || []).length;
  console.log('${} original:', origDollar, 'result:', resDollar, 'match:', origDollar === resDollar ? 'YES' : 'NO');
} catch(e) {
  console.log('FAILED:', e.message);
}
