import {db} from '../../preload/src/database';
import {readFileSync, createWriteStream, existsSync, unlink, mkdirSync} from 'fs';
import {GameElimination} from '../../preload/src/models/GameElimination';
import {GamePlayer} from '../../preload/src/models/GamePlayer';
import {GameStat} from '../../preload/src/models/GameStat';
import {Player} from '../../preload/src/models/Player';
import FortPlayerState from './FortPlayerState.json';
const nodeFetch = require('node-fetch');
const parseReplay = require('fortnite-replay-parser');
const client = require('https');
const sharp = require('sharp');

function parsePlayers(players) {
  const result: Player[] = [];
  players.forEach((p) => {
    if (result.filter(r => [p.BotUniqueId, p.UniqueId].includes(r.playerID)).length == 0) {
      result.push(new Player({
        playerID: p.BotUniqueId ?? p.UniqueId,
        username: p.PlayerNamePrivate,
        isBot: p.bIsABot != null && p.bIsABot ? true : false,
        platform: p.Platform,
        skin: p.Character != null ? p.Character.name : null,
        snipes: 1,
      }));
    }
  });
  return result;
}

function parseEliminations(elims, gameID:string) {
  const result:GameElimination[] = [];
  elims.filter(e => e.group == 'playerElim').forEach((e) => {
      result.push(new GameElimination({
        id: 0,
        gameID: gameID,
        time: e.startTime,
        killerID: e.eliminator,
        killedID: e.eliminated,
        knocked: e.knocked,
        weapon: e.gunType,
      }));
  });
  return result;
}

function parseStats(data, cleanedPlayers, gameID:string, replayName:string, mode:string) {
  const athenaStats = data.events.filter(e => e.metadata == 'AthenaMatchStats').at(-1) ?? {
    startTime: 0,
    eliminations: 0,
    assists: 0,
    accuracy: 0,
    damageToPlayers: 0,
    damageTaken: 0,
    totalTraveled: 0,
  };
  const inCreative = mode.toLowerCase().includes('creative');
  const botCount = inCreative ? 0 : cleanedPlayers.filter(p => p.TeamIndex > 2 && p.bIsABot != null).length;
  const playerCount = cleanedPlayers.filter(p => p.TeamIndex > 2 && p.bIsABot == null).length;
  const ownerID = cleanedPlayers.filter(p => p.Owner != null)[0].UniqueId;
  const gameDuration = Math.max(athenaStats.startTime, data.events.at(-1).startTime);
  return new GameStat({
    gameID: gameID,
    owner: ownerID,
    timestamp: new Date(data.info.Timestamp),
    replayName: replayName,
    mode: mode,
    bots: botCount,
    players: playerCount,
    duration: gameDuration,
    placement: inCreative ? 0 : cleanedPlayers.filter(p => p.UniqueId == ownerID)[0].Place ?? 0,
    kills: inCreative ? 0 : athenaStats.eliminations,
    assists: inCreative ? 0 : athenaStats.assists,
    accuracy: inCreative ? 0 : athenaStats.accuracy,
    damageDealt: inCreative ? 0 : athenaStats.damageToPlayers,
    damageTaken: inCreative ? 0 : athenaStats.damageTaken,
    distanceTravelled: inCreative ? 0 : athenaStats.totalTraveled,
  });
}

function parseGamers(dataPlayers, players:Player[], gameID:string, mode:string) {
  const gamers:GamePlayer[] = [];
  const inCreative = mode.toLowerCase().includes('creative');
  players.forEach((p) => {
    const dataPlayer = dataPlayers.filter(dp => dp.UniqueId == p.playerID || dp.BotUniqueId == p.playerID)[0];
    let teamPlacement = inCreative ? 0 : Math.min(...dataPlayers
      .filter(dp => dp.TeamIndex == dataPlayer.TeamIndex && dp.Place != null)
      .map(dp => dp.Place));
    teamPlacement = teamPlacement == Infinity ? 0 : teamPlacement;
    gamers.push(new GamePlayer({
      id: 0,
      playerID: p.playerID,
      gameID: gameID,
      isBot: p.isBot,
      team: dataPlayer.TeamIndex != null ? dataPlayer.TeamIndex - 2 : -1,
      kills: dataPlayer.KillScore ?? 0,
      placement: teamPlacement,
    }));
  });
  return gamers;
}

async function downloadSkins(players:Player[]) {
  function downloadImage(url:string, filepath:string) {
    return new Promise((resolve, reject) => {
      client.get(url, (res) => {
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

  const skins = players.filter(p => p.skin != null).map(p => p.skin);
  let skinFolder:string;
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

export async function addReplay(path:string) {
  const replayName = path.split('\\').pop() ?? 'Invalid Replay Name';
  const data = await parseReplay(readFileSync(path), {
    customNetFieldExports: [FortPlayerState],
    parseLevel: 1,
    debug: false,
  }).catch((_:Error) => {
    return null;
  });
  if (data == null) {
    return false;
  }
  const gameID:string = data.gameData.gameState.GameSessionId;
  if ((await db.getGameStats(gameID)).gameID.length > 0) {
    return true;
  }
  const mode:string = data.gameData.playlistInfo;
  const cleanedPlayers = data.gameData.players.filter(p => p.BotUniqueId != null || p.UniqueId != null);
	const players = parsePlayers(cleanedPlayers);
	const kills = parseEliminations(data.events, gameID);
	const stat = parseStats(data, cleanedPlayers, gameID, replayName, mode);
  const gamers = parseGamers(cleanedPlayers, players, gameID, mode);
  await downloadSkins(players);
  return await db.addReplay(gamers, kills, players, stat);
}
