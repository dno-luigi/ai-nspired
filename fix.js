const fs = require("fs");
let content = fs.readFileSync("clean.mjs", "utf8");

// Find the line with openCardById and ${c.id}
const searchStr = "openCardById('${c.id}')";
const idx = content.indexOf(searchStr);
if (idx < 0) {
  console.log("Pattern not found!");
  process.exit(1);
}

// Find the full line
const lineStart = content.lastIndexOf("\n", idx) + 1;
const lineEnd = content.indexOf("\n", idx);
const line = content.substring(lineStart, lineEnd);

console.log("Last 5 chars:", JSON.stringify(line.slice(-5)));

// The line should end with: ...borderColor='#2a2a4a'>'
// We need it to end with: ...borderColor='#2a2a4a'>` (backtick instead of single quote)
if (line.endsWith("'")) {
  const newLine = line.slice(0, -1) + "`";
  content = content.substring(0, lineStart) + newLine + content.substring(lineEnd);
  fs.writeFileSync("clean.mjs", content);
  console.log("FIXED! Changed trailing ' to `");
} else {
  console.log("Line does not end with ':", JSON.stringify(line.slice(-10)));
}
