class Player {
  playerID: string;
  username: string;
  isBot: boolean;
  platform: string;
  skin: string;
  snipes: number;

  constructor(data = {
    playerID: '',
    username: 'AI',
    isBot: true,
    platform: 'epic',
    skin: 'epic',
    snipes: 0,
  }) {
    this.playerID = data.playerID.toLowerCase();
    this.username = data.username;
    this.isBot = data.isBot;
    this.platform = data.platform;
    this.skin = data.skin;
    this.snipes = data.snipes;
  }
}

export { Player };
