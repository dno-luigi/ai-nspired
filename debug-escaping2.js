const fs = require("fs");
let c = fs.readFileSync("/tmp/tew/clean.mjs", "utf8");

// The broken pattern in the file is:
//   onclick=\"flipCardEdit(\\\\ + c.id + \\)\"
// Which generates HTML: onclick="flipCardEdit(\\ + c.id + \)"
// We need: onclick=\"flipCardEdit('" + c.id + "')\"

// Fix flipCardEdit
c = c.replace('onclick=\\"flipCardEdit(\\\\\\\\ + c.id + \\\\\\")\\"', 'onclick=\\"flipCardEdit(\\'" + c.id + "\\\')\\"');

// That might not match. Let me try a simpler approach - just find and replace the broken patterns
// using the actual string content

const fixes = [
  // Each: [broken pattern in file, correct replacement]
  ['flipCardEdit(\\\\\\\\ + c.id + \\\\\\)', "flipCardEdit('\" + c.id + \"')"],
  ['elevateFromPicker(\\\\\\\\ + c.id + \\\\\\)', "elevateFromPicker('\" + c.id + \"')"],
  ['elevateCardContent(\\\\\\\\ + cardId + \\\\\\)', "elevateCardContent('\" + cardId + \"')"],
  ['unflipCard(\\\\\\\\ + cardId + \\\\\\)', "unflipCard('\" + cardId + \"')"],
];

// Actually, let me just use a regex approach to find and fix all broken onclick handlers
// Pattern: flipCardEdit(\\ + c.id + \) - where \\ and \) are literal in the file

// In the actual file bytes, the pattern is:
// f l i p C a r d E d i t ( \ \ _ + _ c . i d _ + _ \ \ )
// where \ is a literal backslash character

// In a JS string, to match a literal backslash we need \\
// So to match \\ we need \\\\
// And to match \) we need \\)

// Let me try different approaches
const testPattern1 = 'flipCardEdit(\\\\\\\\ + c.id + \\\\\\)';
const testPattern2 = 'flipCardEdit(\\\\ + c.id + \\\\)';

console.log("Test pattern 1 exists:", c.includes(testPattern1));
console.log("Test pattern 2 exists:", c.includes(testPattern2));

// Find the actual text
const idx = c.indexOf("flipCardEdit(");
const context = c.substring(idx, idx + 40);
console.log("Actual context:", JSON.stringify(context));

// The actual file content after flipCardEdit( is: \\ + c.id + \)"
// In JS string literal, \\ represents one backslash
// So the actual bytes are: backslash backslash space + space c.i d space + space backslash )
// Let me match that
const p1 = "flipCardEdit(\\\\ + c.id + \\\\)"; 
console.log("Pattern with 2 backslashes:", c.includes(p1));
