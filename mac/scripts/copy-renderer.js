// Copies the renderer's static assets (HTML/CSS) into dist/ alongside the
// compiled renderer.js, since tsc only emits the .ts files.
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'ui', 'window', 'renderer');
const outDir = path.join(__dirname, '..', 'dist', 'ui', 'window', 'renderer');

fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  if (/\.(html|css)$/.test(file)) {
    fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
  }
}
console.log('copied renderer html/css → dist/ui/window/renderer');
