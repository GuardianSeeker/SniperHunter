import {Database as sqlite} from 'sqlite3';
import {GameElimination} from './models/GameElimination';
import {GamePlayer} from './models/GamePlayer';
import {GameStat} from './models/GameStats';
import {Player} from './models/Player';

const initStatements = [
  `CREATE TABLE IF NOT EXISTS 'GameEliminations' (
    'id' INTEGER PRIMARY KEY AUTOINCREMENT,
    'gameID' VARCHAR(255) NOT NULL,
    'time' INTEGER NOT NULL,
    'killerID' VARCHAR(255) NOT NULL,
    'killedID' VARCHAR(255) NOT NULL,
    'knocked' TINYINT(1) NOT NULL,
    'weapon' VARCHAR(255) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS 'GamePlayers' (
    'id' INTEGER PRIMARY KEY AUTOINCREMENT,
    'playerID' VARCHAR(255) NOT NULL,
    'gameID' VARCHAR(255) NOT NULL,
    'isBot' TINYINT(1) NOT NULL,
    'team' INTEGER NOT NULL,
    'kills' INTEGER NOT NULL DEFAULT 0,
    'placement' INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS 'GameStats' (
    'gameID' VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY,
    'owner' VARCHAR(255) NOT NULL,
    'timestamp' DATETIME NOT NULL UNIQUE,
    'replayName' VARCHAR(255) NOT NULL,
    'mode' VARCHAR(255) NOT NULL,
    'bots' INTEGER NOT NULL,
    'players' INTEGER NOT NULL,
    'duration' INTEGER DEFAULT -1,
    'placement' INTEGER NOT NULL,
    'kills' INTEGER DEFAULT -1,
    'assists' INTEGER DEFAULT 0,
    'accuracy' DOUBLE PRECISION DEFAULT '-1',
    'damageDealt' INTEGER DEFAULT -1,
    'damageTaken' INTEGER DEFAULT -1,
    'distanceTravelled' DOUBLE PRECISION DEFAULT '-1'
  )`,
  `CREATE TABLE IF NOT EXISTS 'Players' (
    'playerID' VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY,
    'username' VARCHAR(255) NOT NULL,
    'isBot' VARCHAR(255) NOT NULL,
    'platform' VARCHAR(255),
    'skin' VARCHAR(255),
    'snipes' INTEGER NOT NULL DEFAULT 1
  )`,
];

async function getAll(sql:string):Promise<any[]> {
  return new Promise(function (resolve, reject) {
    db.database.all(sql, function (err, rows) {
      if (err) {
        console.log(err);
        return reject(err);
      }
      resolve(rows);
    });
  });
}

async function serialize(sql:string[]):Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.database.serialize(() => {
      function dbRun(x:number) {
        if (x < sql.length) {
          db.database.run(sql[x], (err) => {
            if (err) {
              console.log(err);
              return reject(false);
            }
            else { dbRun(++x); }
          });
        }
        resolve(true);
      }
      dbRun(0);
    });
  });
}

async function exec(sql:string):Promise<boolean> {
  return new Promise(function (resolve, reject) {
    db.database.exec(sql, function (err) {
      if (err) {
        console.log(err);
        return reject(false);
      }
      resolve(true);
    });
  });
}

async function getSingle(sql:string) {
  return new Promise(function (resolve, reject) {
    db.database.get(sql, function (err, rows) {
      if (err) {
        console.log(err);
        return reject(err);
      }
      resolve(rows);
    });
  });
}

function whereInGenerator(data:string[]) {
  return `(${'\'' + data.join('\',\'') + '\''})`;
}

class Database {
  database: sqlite;

  constructor() {
    this.database = new sqlite('database.db', (err) => {
      if (err) console.error('Database opening error: ', err);
    });
    initStatements.forEach((sql) => {
      this.database.run(sql);
    });
  }

  addReplay = async (gamers:GamePlayer[], kills:GameElimination[], players:Player[], stat:GameStat) => {
    function escape(line:string) {
      return line.replaceAll("'", "''");
    }
    let sql:string;
    sql = `INSERT INTO GameStats VALUES ('${stat.gameID}', '${stat.owner}', '${stat.timestamp.toISOString()}', '${escape(stat.replayName)}', '${stat.mode}', ${stat.bots}, ${stat.players}, ${stat.duration}, ${stat.placement}, ${stat.kills}, ${stat.assists}, ${stat.accuracy}, ${stat.damageDealt}, ${stat.damageTaken}, ${stat.distanceTravelled})`;
    if (!await exec(sql)) { return false; }
    sql = `INSERT INTO GamePlayers VALUES ${gamers.map(g => `(NULL, '${g.playerID}', '${g.gameID}', ${g.isBot ? 1 : 0}, ${g.team}, ${g.kills}, ${g.placement})`).join(', ')}`;
    if (!await exec(sql)) { return false; }
    if (kills.length > 0) {
      sql = `INSERT INTO GameEliminations VALUES ${kills.map(k => `(NULL, '${k.gameID}', ${k.time}, '${k.killerID}', '${k.killedID}', ${k.knocked}, '${k.weapon}')`).join(', ')}`;
      if (!await exec(sql)) { return false; }
    }
    const serializeql:string[] = [];
    const playerSql:string[] = [];
    for (let x = 0; x < players.length; x++) {
      const p = players[x];
      const existingPlayer = await this.getPlayer(p.playerID);
      const platform = p.platform == null ? 'NULL' : `'${p.platform}'`;
      let skin = p.skin == null ? 'NULL' : `'${p.skin}'`;
      if (existingPlayer != null) {
        if (existingPlayer.skin != null && skin == 'NULL') {
          skin = existingPlayer.skin;
        }
        serializeql.push(`UPDATE Players SET snipes = snipes + 1, platform = ${platform}, username = '${escape(p.username)}', skin = ${skin} WHERE playerID = '${p.playerID}'`);
      }
      else {
        playerSql.push(`('${p.playerID}', '${escape(p.username)}', ${p.isBot}, ${platform}, ${skin}, ${p.snipes})`);
      }
    }
    if (playerSql.length > 0) {
      sql = (`INSERT INTO Players VALUES ${playerSql.join(', ')}`);
      if (!await exec(sql)) { return false; }
    }
    return await serialize(serializeql);
  };

  getMatchHistory = async (page = 1):Promise<GameStat[]> => {
    const limit = 25;
    const result = await getAll(`SELECT * FROM GameStats ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${(limit * page) - limit}`);
    const matches:GameStat[] = [];
    result.forEach(e => {
      matches.push(new GameStat(e));
    });
    return matches;
  };

  getGamerHistory = async (page = 1, playerID:string):Promise<GameStat[]> => {
    const limit = 25;
    const matches:GameStat[] = [];
    const gamerGames = await getAll(`SELECT gameID FROM GamePlayers WHERE playerID = '${playerID}'`);
    const result = await getAll(`SELECT * FROM GameStats WHERE gameID IN ${whereInGenerator(gamerGames.map(g => g.gameID))} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${(limit * page) - limit}`);
    result.forEach(e => {
      matches.push(new GameStat(e));
    });
    return matches;
  };

  getEliminations = async (gameID: string): Promise<GameElimination[]> => {
    const result = await getAll(`SELECT * FROM GameEliminations WHERE gameID='${gameID}' ORDER BY id`);
    const eliminations:GameElimination[] = [];
    result.forEach(e => {
      eliminations.push(new GameElimination(e));
    });
    return eliminations;
  };

  getGamers = async (gameID: string): Promise<GamePlayer[]> => {
    const result = await getAll(`SELECT * FROM GamePlayers WHERE gameID='${gameID}' ORDER BY team`);
    const gamers:GamePlayer[] = [];
    result.forEach(e => {
      gamers.push(new GamePlayer(e));
    });
    return gamers;
  };

  getGamerPlayers =  async (gamers: GamePlayer[]): Promise<Player[]> => {
    const filtered = gamers.map(g => `${g.playerID}`);
    const result = await getAll(`SELECT * FROM Players WHERE playerID IN ${whereInGenerator(filtered)}`);
    const players:Player[] = [];
    result.forEach(e => {
      players.push(new Player(e));
    });
    return players;
  };

  getGameStats = async (gameID: string): Promise<GameStat> => {
    const result = await getSingle(`SELECT * FROM GameStats WHERE gameID='${gameID}'`);
    return new GameStat(result);
  };

  getPlayer = async (playerID: string): Promise<Player> => {
    const result = await getSingle(`SELECT * FROM Players WHERE playerID='${playerID}'`) as Player;
    return result;
  };

  getPlayers = async (): Promise<Player[]> => {
    const result = await getAll(`SELECT * FROM Players`);
    return (result) as Player[];
  }

  getPlayerGames = async (playerID: string): Promise<GameStat[]> => {
    const result = await getAll(`SELECT * FROM GamePlayers WHERE playerID='${playerID}'`);
    const stats:GameStat[] = [];
    result.forEach(e => {
      stats.push(new GameStat(e));
    });
    return stats;
  };

  getLastGameID = async(): Promise<string> => {
    const result = await getSingle('SELECT * FROM GameStats ORDER BY timestamp DESC LIMIT 1');
    return result != null ? result.gameID : null;
  };

  getSnipers = async(): Promise<Player[]> => {
    const result = await getAll('SELECT * FROM Players ORDER BY snipes DESC');
    const players:Player[] = [];
    result.forEach(e => {
      players.push(new Player(e));
    });
    return players;
  };

  getLastGame = async(): Promise<GameStat | null> => {
    return await getSingle('SELECT * FROM GameStats ORDER BY Timestamp DESC LIMIT 1') as GameStat;
  };

  deleteMatch = async(gameID: string): Promise<boolean> => {
    await exec(`DELETE FROM GameStats WHERE gameID='${gameID}'`);
    await exec(`UPDATE Players SET snipes = snipes - 1 WHERE playerID IN (SELECT playerID FROM GamePlayers WHERE gameID = '${gameID}')`);
    await exec(`DELETE FROM GamePlayers WHERE gameID='${gameID}'`);
    return await exec(`DELETE FROM GameEliminations WHERE gameID='${gameID}'`);
  };
}

export const db = new Database();