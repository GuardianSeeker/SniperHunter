class GameStat {
  gameID: string;
  owner: string;
  timestamp: Date;
  replayName: string;
  mode: string;
  bots: number;
  players: number;
  duration: number;
  placement: number;
  kills: number;
  assists: number;
  accuracy: number;
  damageDealt: number;
  damageTaken: number;
  distanceTravelled: number;

  constructor(data = {
    gameID: '',
    owner: '',
    timestamp: new Date(),
    replayName: '',
    mode: '',
    bots: 0,
    players: 0,
    duration: 0,
    placement: 0,
    kills: 0,
    assists: 0,
    accuracy: 0,
    damageDealt: 0,
    damageTaken: 0,
    distanceTravelled: 0,
  }) {
    this.gameID = data.gameID;
    this.owner = data.owner;
    this.timestamp = data.timestamp;
    this.replayName = data.replayName;
    this.mode = data.mode;
    this.bots = data.bots;
    this.players = data.players;
    this.duration = data.duration;
    this.placement = data.placement;
    this.kills = data.kills;
    this.assists = data.assists;
    this.accuracy = data.accuracy;
    this.damageDealt = data.damageDealt;
    this.damageTaken = data.damageTaken;
    this.distanceTravelled = data.distanceTravelled;
  }
}

export { GameStat };
