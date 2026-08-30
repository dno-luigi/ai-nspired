const fs = require("fs");
let c = fs.readFileSync("clean.mjs", "utf8");

// The broken patterns in the file look like:
//   flipCardEdit(\\ + c.id + \")
//   elevateFromPicker(\\ + c.id + \")
//   elevateCardContent(\\ + cardId + \")
//   unflipCard(\\ + cardId + \")
// These need to become:
//   flipCardEdit('" + c.id + "')
//   etc.

// Use a simple string replacement approach
const fixes = [
  ["flipCardEdit(\\\\ + c.id + \\\")", "flipCardEdit('\" + c.id + \"')"],
  ["elevateFromPicker(\\\\ + c.id + \\\")", "elevateFromPicker('\" + c.id + \"')"],
  ["elevateCardContent(\\\\ + cardId + \\\")", "elevateCardContent('\" + cardId + \"')"],
  ["unflipCard(\\\\ + cardId + \\\")", "unflipCard('\" + cardId + \"')"],
];

for (const [old, rep] of fixes) {
  const count = c.split(old).length - 1;
  if (count > 0) {
    c = c.split(old).join(rep);
    console.log(`Fixed ${count}x: ${old.substring(0, 30)}...`);
  } else {
    console.log(`Not found: ${old.substring(0, 30)}...`);
  }
}

fs.writeFileSync("clean.mjs", c);
console.log("Done");
