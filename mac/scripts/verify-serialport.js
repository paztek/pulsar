// Phase 0 verification: prove the native `serialport` module loads under
// Electron's V8/Node ABI. Run headlessly with `npx electron scripts/verify-serialport.js`.
// If serialport wasn't rebuilt for Electron, require() throws NODE_MODULE_VERSION
// and this exits non-zero.
const { app } = require('electron');

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    console.log(`OK: serialport loaded under Electron ${process.versions.electron} (Node ABI ${process.versions.modules})`);
    console.log(`ports: ${ports.map((p) => p.path).join(', ') || 'none'}`);
    app.exit(0);
  } catch (e) {
    console.error(`FAIL: serialport failed to load — ${e.message}`);
    app.exit(1);
  }
});
