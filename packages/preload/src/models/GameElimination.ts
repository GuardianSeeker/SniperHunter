class GameElimination {
  id: number;
  gameID: string;
  time: number;
  killerID: string;
  killedID: string;
  knocked: boolean;
  weapon: string;

  constructor(data = {
    id: 0,
    gameID: '',
    time: 0,
    killerID: '',
    killedID: '',
    knocked: false,
    weapon: '',
  }) {
    this.id = data.id;
    this.gameID = data.gameID;
    this.time = parseInt(data.time.toString());
    this.killerID = data.killerID;
    this.killedID = data.killedID;
    this.knocked = data.knocked;
    this.weapon = data.weapon;
  }
}

export { GameElimination };
