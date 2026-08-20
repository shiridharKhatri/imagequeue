const fs = require('fs');
const path = require('path');

const htmlContent = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
const tsContent = fs.readFileSync(path.join(__dirname, 'popup.ts'), 'utf8');

const idRegex = /\$\s*<[^>]+>\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|\$\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
let match;
const ids = new Set();
while ((match = idRegex.exec(tsContent)) !== null) {
  const id = match[1] || match[2] || match[3];
  if (id) ids.add(id);
}

console.log('Found IDs in popup.ts:', Array.from(ids));

const missingIds = [];
for (const id of ids) {
  if (!htmlContent.includes(`id="${id}"`) && !htmlContent.includes(`id='${id}'`)) {
    missingIds.push(id);
  }
}

if (missingIds.length > 0) {
  console.error('MISSING IDs in popup.html:', missingIds);
  process.exit(1);
} else {
  console.log('All IDs verified successfully!');
}
