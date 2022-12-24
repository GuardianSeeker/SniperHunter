import {app, ipcMain, dialog} from 'electron';
import './security-restrictions';
import {restoreOrCreateWindow} from '/@/mainWindow';
import {watch} from 'chokidar';
import {addReplay} from './replayParser';

let window:Electron.BrowserWindow;

const isSingleInstance = app.requestSingleInstanceLock();
if (!isSingleInstance) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', restoreOrCreateWindow);

//app.disableHardwareAcceleration();

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', restoreOrCreateWindow);

app
  .whenReady()
  .then(async () => {window = await restoreOrCreateWindow();})
  .catch(e => console.error('Failed create window:', e));


function resolveToAbsolutePath(path) {
  return path.replace(/%([^%]+)%/g, function (_, key) {
    return process.env[key];
  });
}

const replayFolder = resolveToAbsolutePath('%LOCALAPPDATA%\\FortniteGame\\Saved\\Demos');

watch(replayFolder, {
  awaitWriteFinish: {
    stabilityThreshold: 1000,
  },
}).on('change', async (path) => {
  const result = await addReplay(path);
  if (result) {
    window.reload();
  }
});

ipcMain.handle('addReplay', async (_) => {
  const res = await dialog.showOpenDialog({properties: ['openFile', 'multiSelections'], defaultPath: replayFolder});
  if (!res.canceled && res.filePaths.length > 0) {
    for (let x = 0; x < res.filePaths.length; x++) {
      const path = res.filePaths[x];
      const result = await addReplay(path);
      if (res.filePaths.length == 1 && result) {
        return 'last';
      }
    }
  }
  return null;
});

ipcMain.on('closeProgram', () => {
	app.exit();
});

ipcMain.on('minimizeProgram', () => {
  window.minimize();
});
