const fs = require("fs");
let content = fs.readFileSync("clean.mjs", "utf8");

// The line currently has unescaped backticks inside the outer HTML template literal
// Original broken: return `<div onclick="openCardById('${c.id}')" ...>`
// Needs to be:    return \`<div onclick="openCardById('\${c.id}')" ...>\`

const broken = 'return `<div onclick="openCardById(\'${c.id}\')" style="padding:8px 12px;border:1px solid #2a2a4a;border-radius:6px;margin-bottom:6px;cursor:pointer;font-size:12px;display:flex;justify-content:space-between;align-items:center;transition:all 0.15s;" onmouseover="this.style.borderColor=\'#ff6b1a\'" onmouseout="this.style.borderColor=\'#2a2a4a\'">`';
const fixed = 'return \\\`<div onclick="openCardById(\\\'${c.id}\\\')" style="padding:8px 12px;border:1px solid #2a2a4a;border-radius:6px;margin-bottom:6px;cursor:pointer;font-size:12px;display:flex;justify-content:space-between;align-items:center;transition:all 0.15s;" onmouseover="this.style.borderColor=\\\'#ff6b1a\\\'" onmouseout="this.style.borderColor=\\\'#2a2a4a\\\'">\\\`';

// Actually, let me be more careful. Let me just look at what's there and replace precisely
const line = content.split('\n')[1910]; // 0-indexed line 1911
console.log("Current line starts with:", JSON.stringify(line.substring(0, 60)));
console.log("Current line ends with:", JSON.stringify(line.substring(line.length - 40)));

// Replace unescaped backtick template literal with escaped version
// The return statement needs: \`...\` instead of `...`
// And ${c.id} needs to be \${c.id}

// Strategy: Replace the return `...` with return \`...\`
// But we need to be careful with the escaping
if (line.includes("return `")) {
  // Replace the backticks with escaped backticks, and ${c.id} with \${c.id}
  let newLine = line
    .replace('return `', 'return \\`')
    .replace(/\$\{c\.id\}/g, '\\${c.id}')
    .replace(/onmouseover="this\.style\.borderColor='#ff6b1a'"/, 'onmouseover="this.style.borderColor=\\\'#ff6b1a\\\'"')
    .replace(/onmouseout="this\.style\.borderColor='#2a2a4a'"/, 'onmouseout="this.style.borderColor=\\\'#2a2a4a\\\'"');
  
  // Fix the closing backtick - the line currently ends with >' followed by backtick
  // We need it to end with >' followed by escaped backtick
  // The line ends with: ...#2a2a4a'">`  (backtick, single quote before is HTML attribute)
  // Wait, let me check what it actually ends with
  
  // Current: onmouseout="this.style.borderColor='#2a2a4a'">`
  // After replacements above, the inner single quotes got escaped too
  // Let me just check the ending
  console.log("New line ends with:", JSON.stringify(newLine.substring(newLine.length - 40)));
  
  // The closing backtick of the template literal also needs escaping
  // Line ends with: >\` (after our replacements)
  // Actually let me just check
  if (newLine.endsWith('`')) {
    newLine = newLine.slice(0, -1) + '\\`';
    console.log("Also escaped closing backtick");
  }
  
  // Also the opening onmouseover/onmouseout single quotes need fixing
  // Let me check the full line for correctness
  console.log("New line:", JSON.stringify(newLine.substring(0, 120)));
  console.log("New line end:", JSON.stringify(newLine.substring(newLine.length - 60)));
  
  const lines = content.split('\n');
  lines[1910] = newLine;
  content = lines.join('\n');
  fs.writeFileSync('clean.mjs', content);
  console.log("DONE");
} else {
  console.log("Pattern 'return `' not found on line 1911");
  console.log("Full line:", JSON.stringify(line.substring(0, 200)));
}
