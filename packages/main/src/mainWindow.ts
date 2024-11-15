import {app, BrowserWindow, screen} from 'electron';
import {join} from 'path';
import {URL} from 'url';
const Store = require('electron-store');

const store = new Store();
const settings = {
  winX: store.get('winX') ?? 0,
  winY: store.get('winY') ?? 0,
  winWidth: store.get('winWidth') ?? 1000,
  winHeight: store.get('winHeight') ?? 600,
};



async function createWindow() {
  function isInFrame() {
    const displays = screen.getAllDisplays();
    return displays
      .map(dp => dp.bounds)
      .filter(dp => dp.x <= settings.winX &&
        (dp.x + dp.width) >= settings.winX &&
        dp.y <= settings.winY &&
        (dp.y + dp.height) >= settings.winY)[0] != null;
  }
  const inFrame = isInFrame();
  const browserWindow = new BrowserWindow({
    show: false, // Use the 'ready-to-show' event to show the instantiated BrowserWindow.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Sandbox disabled because the demo of preload script depend on the Node.js api
      webviewTag: false, // The webview tag is not recommended. Consider alternatives like an iframe or Electron's BrowserView. @see https://www.electronjs.org/docs/latest/api/webview-tag#warning
      preload: join(app.getAppPath(), 'packages/preload/dist/index.cjs'),
    },
    icon: join(app.getAppPath(), 'packages/main/assets/icon.ico'),
    frame: false,
    minWidth: 1200,
    minHeight: 600,
    x: inFrame ? settings.winX : 0,
    y: inFrame ? settings.winY : 0,
    width: settings.winWidth,
    height: settings.winHeight,
  });

  /**
   * If the 'show' property of the BrowserWindow's constructor is omitted from the initialization options,
   * it then defaults to 'true'. This can cause flickering as the window loads the html content,
   * and it also has show problematic behaviour with the closing of the window.
   * Use `show: false` and listen to the  `ready-to-show` event to show the window.
   *
   * @see https://github.com/electron/electron/issues/25012 for the afford mentioned issue.
   */
  browserWindow.on('ready-to-show', () => {
    browserWindow?.show();

    if (import.meta.env.DEV) {
      browserWindow?.webContents.openDevTools();
    }
  });

  /**
   * URL for main window.
   * Vite dev server for development.
   * `file://../renderer/index.html` for production and test.
   */
  const pageUrl =
    import.meta.env.DEV && import.meta.env.VITE_DEV_SERVER_URL !== undefined
      ? import.meta.env.VITE_DEV_SERVER_URL
      : new URL('../renderer/dist/index.html', 'file://' + __dirname).toString();

  await browserWindow.loadURL(pageUrl);

  browserWindow.on('move', () => {
    const position = browserWindow.getPosition();
    store.set('winX', position[0]);
    store.set('winY', position[1]);
  });

  browserWindow.on('resize', () => {
    const size = browserWindow.getSize();
    store.set('winWidth', size[0]);
    store.set('winHeight', size[1]);
  });

  return browserWindow;
}

/**
 * Restore an existing BrowserWindow or Create a new BrowserWindow.
 */
export async function restoreOrCreateWindow() {
  let window = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());

  if (window === undefined) {
    window = await createWindow();
  }

  if (window.isMinimized()) {
    window.restore();
  }

  window.focus();
  return window;
}
