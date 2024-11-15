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
    this.gameID = data.gameID.toLowerCase();
    this.time = data.time;
    this.killerID = data.killerID.toLowerCase();
    this.killedID = data.killedID.toLowerCase();
    this.knocked = data.knocked;
    this.weapon = data.weapon;
  }
}

export { GameElimination };
