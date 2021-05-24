module.exports = class Player {
	constructor(id, username, platform, team=null, games=[]) {
		this.id = id;
		this.username = username;
		this.platform = platform;
		this.team = team;
		this.games = games;
	}
	
	static isEqual(player) {
		return player.id = this.id;
	}

	static isTeammate(player) {
		if (!player.team) return false;
		else return player.team == this.team;
	}
};