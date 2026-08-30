const fs = require("fs");
let c = fs.readFileSync("/tmp/tew/clean.mjs", "utf8");

// The broken HTML onclick handlers have literal \\ in the file
// We need to find: flipCardEdit(\\ + c.id + \)
// And replace with: flipCardEdit('" + c.id + "')

// Find all occurrences and show them
const patterns = [
  "flipCardEdit(\\\\\\ + c.id + \\\\)",
  "elevateFromPicker(\\\\\\ + c.id + \\\\)",
  "elevateCardContent(\\\\\\ + cardId + \\\\)",
  "unflipCard(\\\\\\ + cardId + \\\\)",
];

// Actually let me just find them by searching for the raw text
const searchTerms = ["flipCardEdit(\\\\", "elevateFromPicker(\\\\", "elevateCardContent(\\\\", "unflipCard(\\\\"];
for (const term of searchTerms) {
  const count = c.split(term).length - 1;
  console.log(`${term.substring(0, 25)}: ${count} occurrences`);
}

// Let me check what's actually there
const idx = c.indexOf("flipCardEdit(\\\\");
if (idx >= 0) {
  console.log("Context:", JSON.stringify(c.substring(idx - 10, idx + 50)));
} else {
  // Try single backslash
  const idx2 = c.indexOf("flipCardEdit(\\");
  if (idx2 >= 0) {
    console.log("Single backslash context:", JSON.stringify(c.substring(idx2 - 10, idx2 + 50)));
  } else {
    console.log("flipCardEdit not found with any backslash pattern");
    // Find where flipCardEdit is used in HTML
    const idx3 = c.indexOf("onclick=\"flipCardEdit");
    if (idx3 >= 0) {
      console.log("onclick context:", JSON.stringify(c.substring(idx3, idx3 + 60)));
    }
  }
}
