/**
 * Packaging for Windows.
 *
 * Two artifacts, on purpose. The NSIS installer is for people who want a Start-menu entry and an
 * uninstaller. The portable build is for people who cannot install software on their machine, or
 * who want the app on a USB stick — it writes its data next to the executable rather than into the
 * user profile, so it leaves nothing behind.
 *
 * Code signing: the config reads a certificate from the environment when CI has one and simply
 * omits it otherwise. It never fabricates a signature or suppresses the SmartScreen warning, and
 * `docs/windows-companion/README.md` tells people what an unsigned build looks like when it runs.
 */
const { readFileSync } = require('node:fs');

const pkg = JSON.parse(readFileSync(require('node:path').join(__dirname, 'package.json'), 'utf8'));

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.nowplaying.companion',
  productName: 'Now Playing Companion',
  copyright: `Copyright © ${new Date().getFullYear()} Now Playing contributors`,
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  /**
   * Only what the app runs from. The TypeScript sources, tests and the renderer's own source tree
   * are deliberately excluded: shipping them would double the download and put the build's internals
   * in front of anyone who unpacks the asar.
   */
  files: ['dist/main/**/*', 'dist/renderer/**/*', 'resources/icon.ico', 'resources/tray.ico', 'resources/tray-*.png', 'package.json', '!**/*.map', '!node_modules/**/{test,__tests__,tests,example,examples}/**'],
  asar: true,
  // The native SQLite binding has to stay a real file on disk; it cannot be loaded from inside asar.
  asarUnpack: ['**/node_modules/better-sqlite3/**'],
  // The AWSP streaming server (awsp-server/, Rust) ships beside the app as its own executable; the
  // main process finds it in resources/ (src/main/awsp.ts findAwspBinary). Built by `cargo build
  // --release` in awsp-server/ before packaging; when it is absent, streaming says so in Settings.
  extraResources: [{ from: 'awsp-server/target/release/awsp-server.exe', to: 'awsp-server.exe' }],
  npmRebuild: true,
  electronLanguages: ['en-US'],
  win: {
    icon: 'resources/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64', 'arm64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    artifactName: '${productName} ${version} ${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Now Playing Companion',
    // Uninstalling removes the program. It does not delete a person's library database or their
    // music; an uninstaller that took someone's playlists with it would be a data-loss bug.
    deleteAppDataOnUninstall: false,
    artifactName: '${productName} Setup ${version} ${arch}.${ext}',
    include: undefined,
  },
  portable: {
    // The portable build keeps its data beside the executable, so a USB stick carries everything
    // and the host machine's profile is untouched.
    unpackDirName: 'NowPlayingCompanion',
    artifactName: '${productName} Portable ${version} ${arch}.${ext}',
  },
  publish: null,
  extraMetadata: {
    name: 'now-playing-companion',
    version: pkg.version,
    main: 'dist/main/index.cjs',
  },
};
