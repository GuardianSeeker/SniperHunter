class GamePlayer {
  id: number;
  playerID: string;
  gameID: string;
  isBot: boolean;
  team: number;
  kills: number;
  placement: number;

  constructor(data = {
    id: 0,
    playerID: '',
    gameID: '',
    isBot: true,
    team: 0,
    kills: 0,
    placement: 999,
  }) {
    this.id = data.id;
    this.playerID = data.playerID;
    this.gameID = data.gameID;
    this.isBot = data.isBot;
    this.team = data.team;
    this.kills = data.kills;
    this.placement = data.placement;
  }
}

export { GamePlayer };
