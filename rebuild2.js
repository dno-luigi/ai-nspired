const fs = require('fs');

const servedHtml = fs.readFileSync('/tmp/tew/served-working.html', 'utf8');
const src = fs.readFileSync('/tmp/tew/worker-clean.mjs', 'utf8');

const marker = 'var INDEX_HTML = `';
const start = src.indexOf(marker);

const before = src.substring(0, start);

const afterMarker = '\nvar server_default';
const afterIdx = src.indexOf(afterMarker);
const after = src.substring(afterIdx);

// Smart escaping: only escape bare backticks (not already-escaped \`)
// and ${ that aren't already \${
function escapeForTemplateLiteral(html) {
  let result = '';
  for (let i = 0; i < html.length; i++) {
    if (html[i] === '\\' && i + 1 < html.length && html[i + 1] === '`') {
      // Already escaped backtick - keep as-is
      result += '\\`';
      i++;
    } else if (html[i] === '\\' && i + 1 < html.length && html[i + 1] === '$') {
      // Already escaped $ - keep as-is  
      result += '\\$';
      i++;
    } else if (html[i] === '`') {
      // Bare backtick - escape it
      result += '\\`';
    } else if (html[i] === '$' && html[i + 1] === '{') {
      // Bare ${ - escape it
      result += '\\${';
      i++;
    } else {
      result += html[i];
    }
  }
  return result;
}

const escaped = escapeForTemplateLiteral(servedHtml);

const newSrc = before + 'var INDEX_HTML = `' + escaped + '`' + after;

fs.writeFileSync('/tmp/tew/worker-clean.mjs', newSrc);
console.log('Rebuilt. Total size:', newSrc.length);

// Verify template evaluates
try {
  const test = new Function('return `' + escaped.substring(0, 1000) + '`');
  const result = test();
  console.log('Template eval OK');
  // Check that backticks appear correctly in output
  const backtickCount = (result.match(/`/g) || []).length;
  console.log('Backticks in output:', backtickCount);
} catch(e) {
  console.log('Template eval FAILED:', e.message);
}
