import { db } from '../../preload/src/database';
import { createWriteStream, existsSync, unlink, mkdirSync } from 'fs';
import { GameElimination } from '../../preload/src/models/GameElimination';
import { GamePlayer } from '../../preload/src/models/GamePlayer';
import { GameStat } from '../../preload/src/models/GameStats';
import { Player } from '../../preload/src/models/Player';
import * as net from 'net';
import { ReplayData, PlayerDataEntity, GunType } from './datatypes';
const nodeFetch = require('node-fetch');
const client = require('https');
const sharp = require('sharp');
const crypto = require('crypto');
//import FortPlayerState from './FortPlayerState.json';
//const parseReplay = require('fortnite-replay-parser');

let replay:ReplayData;

async function replayIPC(path:string, replayName:string): Promise<ReplayData> {
  const PIPE_NAME = `\\\\.\\pipe\\${replayName}`;
  try {
    if (require('fs').existsSync(PIPE_NAME)) {
      require('fs').unlinkSync(PIPE_NAME);
    }
  } catch (e) {
  }

  var cp = require("child_process");
  cp.exec("replayParser\\FortReplayParser.exe " + path);

  return new Promise((resolve, reject) => {
    const server = net.createServer((stream) => {
      let data = '';

      stream.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      stream.on('end', () => {
        const value = data.trim();
        server.close();
        if (value === "Replay in progress.") {
          reject(value);
        }
        else {
          resolve(JSON.parse(value) as ReplayData);
        }
      });

      stream.on('error', (error) => {
        console.error('Stream error:', error);
        server.close();
        reject(error);
      });
    });

    server.on('error', (error) => {
      console.error('Server error:', error);
      reject(error);
    });

    server.listen(PIPE_NAME);
  });
}

async function parsePlayers(players:PlayerDataEntity[]) {
  const result: Player[] = [];
  const existingPlayers = await db.getPlayers();
  players.forEach((p) => {
    let duplicateReplayEntities = result.filter(r => [p.BotId, p.EpicId, p.PlayerId].includes(r.playerID.toUpperCase()));
    if (duplicateReplayEntities.length == 0) {
      const playerId = (p.BotId ?? p.EpicId ?? p.PlayerId ?? 'BadPlayerId').toLowerCase();
      const preExisting = existingPlayers.find(ep => ep.playerID == playerId);
      result.push(new Player({
        playerID: playerId,
        username: p.PlayerName != null ?
          p.PlayerName : 
          preExisting?.username ?? '',
        isBot: p.IsBot,
        platform: p.Platform != null ? p.Platform : preExisting?.platform ?? 'NULL',
        skin: p.Cosmetics.Character != null ? p.Cosmetics.Character : preExisting?.skin ?? '',
        snipes: 1,
      }));
    }
  });
  return result;
}

function parseEliminations(gameID: string) {
  const elims = replay.Eliminations;
  const result: GameElimination[] = [];
  if (elims != null && elims.length > 0) {
    elims.forEach((e) => {
      const timeM = parseInt(e.Time.split(':')[0]);
      const timeS = parseInt(e.Time.split(':')[1]);
      result.push(new GameElimination({
        id: 0,
        gameID: gameID,
        time: 1000 * (timeM * 60 + timeS),
        killerID: e.Eliminator,
        killedID: e.Eliminated,
        knocked: e.Knocked,
        weapon: GunType[e.GunType] ?? 50,
      }));
    });
  }
  return result;
}

function parseStats(nonNpcPlayers: PlayerDataEntity[], gameID: string, replayName: string, mode: string) {
  const inCreative = mode.toLowerCase().includes('creative');
  const botCount = inCreative ? 0 : nonNpcPlayers.filter(p => p.TeamIndex > 2 && p.IsBot).length;
  const playerCount = nonNpcPlayers.filter(p => p.TeamIndex > 2 && !p.IsBot).length;
  const ownerPlayer = inCreative ? null : nonNpcPlayers.find(p => p.IsReplayOwner)!;
  const ownerID = ownerPlayer != null ? ownerPlayer.EpicId ?? ownerPlayer.PlayerId ?? 'BadPlayerId' : 'null';
  const gameDuration = replay.Info.LengthInMs;
  return new GameStat({
    gameID: gameID,
    owner: ownerID,
    timestamp: new Date(replay.Info.Timestamp),
    replayName: replayName,
    mode: mode,
    bots: botCount,
    players: playerCount,
    duration: gameDuration,
    placement: inCreative ? 0 : replay.TeamStats ? replay.TeamStats.Position : 0,
    kills: inCreative ? 0 : replay.Stats ? replay.Stats.Eliminations : 0,
    assists: inCreative ? 0 : replay.Stats ? replay.Stats.Assists : 0,
    accuracy: inCreative ? 0 : replay.Stats ? replay.Stats.Accuracy : 0,
    damageDealt: inCreative ? 0 : replay.Stats ? replay.Stats.DamageToPlayers : 0,
    damageTaken: inCreative ? 0 : replay.Stats ? replay.Stats.DamageTaken : 0,
    distanceTravelled: inCreative ? 0 : replay.Stats ? replay.Stats.TotalTraveled : 0,
  });
}

function parseGamers(nonNpcPlayers:PlayerDataEntity[], players: Player[], gameID: string, mode: string) {
  const gamers: GamePlayer[] = [];
  const inCreative = mode.toLowerCase().includes('creative');
  players.forEach((p) => {
    const dataPlayer = nonNpcPlayers.find(dp => [dp.BotId?.toLowerCase(), dp.EpicId?.toLowerCase(), dp.PlayerId?.toLowerCase()].includes(p.playerID))!;
    let team = replay.TeamData?.find(t => t.TeamIndex == dataPlayer.TeamIndex)!;
    let teamPlacement = inCreative ? 0 : team.Placement ?? 0;
    gamers.push(new GamePlayer({
      id: 0,
      playerID: p.playerID,
      gameID: gameID,
      isBot: p.isBot,
      team: dataPlayer.TeamIndex != null ? dataPlayer.TeamIndex - 2 : -1,
      kills: dataPlayer.Kills ?? 0,
      placement: teamPlacement,
    }));
  });
  return gamers;
}

async function downloadSkins(players: Player[]) {
  function downloadImage(url: string, filepath: string) {
    return new Promise((resolve, reject) => {
      client.get(url, (res: any) => {
        if (res.statusCode === 200) {
          res.pipe(createWriteStream(filepath))
            .on('error', reject)
            .once('close', async () => {
              await sharp(filepath).resize(64).toFile(filepath.replace('_rawFile', ''));
              unlink(filepath, (err) => {
                if (err) { reject(false); }
                resolve(true);
              });
            });
        } else {
          res.resume();
          reject(false);
        }
      });
    });
  }

  const skins = players.filter(p => p.skin != 'null' && p.skin != '').map(p => p.skin);
  let skinFolder: string;
  if (import.meta.env.DEV) {
    skinFolder = `${__dirname.split('\\').slice(0, -2).join('/')}/renderer/assets/skins/`;
  }
  else {
    skinFolder = `${__dirname.split('\\').slice(0, -2).join('/')}/assets/skins/`;
  }
  if (!existsSync(skinFolder)) {
    mkdirSync(skinFolder, { recursive: true });
  }
  for (let x = 0; x < skins.length; x++) {
    const skinPath = skinFolder + skins[x] + '.png';
    const exists = existsSync(`${skinPath}`);
    if (!exists) {
      const url = `https://fortnite-api.com/v2/cosmetics/br/${skins[x]}`;
      const res = await nodeFetch(url);
      const jbody = await res.json();
      if (jbody.data != null && await downloadImage(jbody.data.images.smallIcon, `${skinFolder + skins[x] + '_rawFile.png'}`) == false) {
        console.log('Failed to download skin.');
      }
    }
  }
}

export async function addReplay(path: string) {
  function createGameSessionID():string {
    return crypto.createHash('md5').update(new Date(replay.Info.Timestamp).getTime().toString()).digest('hex');
  }
  /*
  const data = await parseReplay(readFileSync(path), {
    customNetFieldExports: [FortPlayerState],
    parseLevel: 1,
    debug: false,
  }).catch((_:Error) => {
    return null;
  }) as ReplayData;
  */
  const replayName = path.split('\\').pop() ?? 'Invalid Replay Name';
  if (replayName === "Invalid Replay Name") return false;
  try {
    replay = await replayIPC(path, replayName);
  }
  catch {
    return false;
  }
  if (replay == null) {
    return false;
  }
  const lastGame = await db.getLastGame();
  const SPLIT_REPLAY_TIME = 1794000;
  if ((lastGame != null && lastGame.gameID.includes('-') && lastGame.duration > SPLIT_REPLAY_TIME) || replay.Info.LengthInMs > SPLIT_REPLAY_TIME) {
    if (lastGame != null && lastGame.gameID.split("-").length > 1) {
      const gameIdx = lastGame.gameID.split("-");
      const nextIdx = parseInt(gameIdx[1]) + 1;
      replay.GameData.GameSessionId = gameIdx[0] + `-${nextIdx}`;
    }
    else {
      replay.GameData.GameSessionId = (replay.GameData.GameSessionId ?? createGameSessionID()) + "-0";
    }
  }
  let gameID = replay.GameData.GameSessionId ?? createGameSessionID();
  if ((await db.getGameStats(gameID)).gameID.length > 0) {
    return true;
  }
  const mode: string = replay.GameData.CurrentPlaylist ?? 'CREATIVE_UNREAL';
  const nonNpcPlayers = replay.PlayerData?.filter(p => p.BotId != null || p.EpicId != null || p.PlayerId != null) ?? [];
  const players = await parsePlayers(nonNpcPlayers);
  const kills = parseEliminations(gameID);
  const stat = parseStats(nonNpcPlayers, gameID, replayName, mode);
  const gamers = parseGamers(nonNpcPlayers, players, gameID, mode);
  await downloadSkins(players);
  return await db.addReplay(gamers, kills, players, stat);
}
