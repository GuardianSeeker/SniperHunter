import {ipcRenderer, shell} from 'electron';
const nodeFetch = require('node-fetch');

function closeProgram() {
  ipcRenderer.send('closeProgram');
}

function minimizeProgram() {
  ipcRenderer.send('minimizeProgram');
}

function openUrl(url:string) {
  shell.openExternal(url);
}

async function checkUpdate() {
  const updateURL = 'https://raw.githubusercontent.com/GuardianSeeker/SniperHunter/master/version';
  const version = 3;
  const res = await nodeFetch(updateURL);
  const latestVersion = parseFloat(await res.text());
  return latestVersion > version;
}

async function addReplay() {
  const result = await ipcRenderer.invoke('addReplay');
  return result as string;
}

export {closeProgram, minimizeProgram, openUrl, addReplay, checkUpdate};
