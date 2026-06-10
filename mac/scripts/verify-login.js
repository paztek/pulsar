// Verifies the launch-at-login API toggles correctly. Toggles ON then OFF so it
// leaves no stray login item registered. Run: npx electron scripts/verify-login.js
const { app } = require('electron');

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  const before = app.getLoginItemSettings().openAtLogin;

  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  const afterOn = app.getLoginItemSettings().openAtLogin;

  app.setLoginItemSettings({ openAtLogin: false, openAsHidden: true });
  const afterOff = app.getLoginItemSettings().openAtLogin;

  console.log(`before=${before} afterOn=${afterOn} afterOff=${afterOff}`);
  const pass = afterOn === true && afterOff === false;
  console.log(pass ? 'OK: launch-at-login toggles (left OFF)' : 'FAIL: toggle did not take effect');
  app.exit(pass ? 0 : 1);
});
