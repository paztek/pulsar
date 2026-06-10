// electron-builder afterPack hook: ad-hoc code-sign the assembled .app.
//
// Without a Developer ID, electron-builder skips signing and the bundle keeps
// Electron's prebuilt linker signature, whose identifier is "Electron" and which
// does not bind our Info.plist. macOS's notification daemon (usernoted) keys off
// the bundle identifier but won't trust an unbound Info.plist, so it silently
// drops notifications. A proper ad-hoc sign (`codesign -s -`) binds the Info.plist
// and stamps the real identifier (com.matthieubalmes.pulsar), which fixes it.
// Ad-hoc signing is free (no certificate) and fine for local/unsigned install.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, app);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`after-pack: ad-hoc signed ${appPath}`);
};
