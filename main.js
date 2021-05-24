const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require("electron");
const { readFile, writeFile } = require("fs").promises;
const { existsSync, readFileSync } = require("fs");
const { Client } = require("fnbr");
const { execFile } = require("child_process");
var request = require("request");
var Player = require("./player.js");
const chokidar = require("chokidar");

var win, client, logFeed, version = "2.1";
var config = { snipeCounts: 2, logFeed: false, position: { x: 0, y: 0 }, size: { x: 850, y: 460 }, friends: [] }, database = { sessions: {}, players: {} }, barMoving = false;

/* Initial startup */
try {
	if (existsSync("config.json")) config = JSON.parse(readFileSync("./config.json", { encoding: "utf-8" }));
	else writeFile("config.json", JSON.stringify(config));
} catch (err) {
	writeFile("config.json", JSON.stringify(config));
}
try {
	if (existsSync("database.json")) database = JSON.parse(readFileSync("./database.json", { encoding: "utf-8" }));
	else writeFile("database.json", JSON.stringify(database));
} catch (err) {
	writeFile("database.json", JSON.stringify(database));
}
logFeed = config["logFeed"];

/* Epic/Fortnite connection */

(async () => {
	setTimeout(() => {
		request({
			uri: "https://raw.githubusercontent.com/GuardianSeeker/SniperHunter/master/version",
			}, function(error, response, body) {
				if (body.trim() < version) logMessage(`You have the latest version! (${version})`);
				else logMessage(`Please update to the newest version from https://github.com/GuardianSeeker/SniperHunter !`);
				logMessage("Connecting to EPIC servers...");
		});
	}, 1000);
	let auth;
	try {
		auth = { deviceAuth: JSON.parse(await readFile("./deviceAuth.json")) };
	} catch (e) {
		logMessage("Connection to EPIC servers failed.");
	}
	try {
		client = new Client({ auth });
		client.on("deviceauth:created", (da) => writeFile("./deviceAuth.json", JSON.stringify(da, null, 2)));
		await client.login();
		logMessage(`Logged in as ${client.user.displayName}.`);
	} catch (e) {
		win.close();
	}
})();

/* File/Directory watchers */

var replayWatcher = chokidar.watch(resolveToAbsolutePath("%LOCALAPPDATA%\\FortniteGame\\Saved\\Demos"), { persistent: true, ignoreInitial: true, interval: 300 });
replayWatcher
	.on("add", (file) => {
		logMessage(`New replay detected: ${file.split("\\").pop()}.`);
	})
	.on("change", (file) => {
		execFile("ReplayParser.exe", [file]);
	});

var newReplay = chokidar.watch("./playerList.json", { persistent: true, ignoreInitial: true, interval: 300 });
newReplay
	.on("add", () => {
		setTimeout(parseReplay, 300);
	})
	.on("change", () => {
		setTimeout(parseReplay, 300);
	});

/* Electron Setup */

app.on("ready", function () {
	const mainMenuTemplate = [
		{
			label: "Main",
			submenu: [
				{
					label: "Add Replay",
					accelerator: process.platform === 'darwin' ? 'Ctrl+O' : 'Ctrl+O',
					click() {
						dialog.showOpenDialog({ properties: ["openFile"], defaultPath: resolveToAbsolutePath("%LOCALAPPDATA%\\FortniteGame\\Saved\\Demos"), browserWindow: win })
							.then((e) => {
								if (!e.canceled && e.filePaths.length > 0) {
									logMessage(`Manually adding ${e.filePaths.split("\\").pop()}.`);
									execFile("ReplayParser.exe", [e.filePaths]);
								}
							});
					}
				},
				{
					label: "Fix Null Names",
					click() {
						fixNullNames();
					}
				},
				{
					label: "Exit",
					accelerator: process.platform === 'darwin' ? 'Ctrl+W' : 'Ctrl+W',
					click() {
						app.exit();
					}
				}
			]
		},
		{
			label: "Extras",
			submenu: [
				{
					label: "Kill Feed Logging",
					type: "checkbox",
					checked: logFeed,
					click() {
						logFeed = !logFeed;
					}
				},
				{
					label: "Got an idea? Message me!",
					click() {
						shell.openExternal(`https://discord.gg/vw6Rh6J`, {activate: true});
					}
				}/*,
				{ 	// DISABLE IN RELEASE
					label: "Debug",
					accelerator: process.platform === 'darwin' ? 'Ctrl+Shift+I' : 'Ctrl+Shift+I',
					click() {
						win.webContents.openDevTools()
					}
				}*/
			]
		},
		{
			label: "Help",
			submenu: [
				{
					label: "Reset Database",
					click() {
						win.webContents.send("database-reset");
					}
				},
				{
					label: "About/Support",
					click() {
						var winpos = win.getPosition();
						var winsize = win.getSize();
						var winx = Math.round(winpos[0] + (winsize[0] / 2) - 300), winy = Math.round(winpos[1] + (winsize[1] / 2) - 180);
						const child = new BrowserWindow({
							parent: win,
							width: 600,
							height: 360,
							icon: "icon.ico",
							x: winx,
							y: winy,
							autoHideMenuBar: true
						});
						child.loadFile("about.html");
						child.show();
					}
				}
			]
		}
	];
	win = new BrowserWindow({
		width: config["size"]["x"],
		height: config["size"]["y"],
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false
		},
		icon: "icon.ico",
		x: config["position"]["x"],
		y: config["position"]["y"]
	});
	win.setMinimumSize(850, 460);
	win.loadFile("index.html");
	win.on("close", async (e) => {
		if (barMoving) e.preventDefault();
		var winpos = win.getPosition();
		var winsize = win.getSize();
		config["position"]["x"] = winpos[0];
		config["position"]["y"] = winpos[1];
		config["size"]["x"] = winsize[0];
		config["size"]["y"] = winsize[1];
		config["logFeed"] = logFeed;
		await writeFile("config.json", JSON.stringify(config));
	});
	const menu = Menu.buildFromTemplate(mainMenuTemplate);
	Menu.setApplicationMenu(menu);
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

/* ipc callbacks */

ipcMain.on("get-player", function (e, playerID) {
	async function profile(id) {
		var user = await client.getProfile(id);
		win.webContents.send("send-player", user.displayName);
	}
	profile(playerID);
});

ipcMain.on("load-player", function (e, username) {
	d = Object.keys(database["players"]);
	for (var x = 0; x < d.length; x++) {
		if (database["players"][d[x]]["username"] == username) {
			win.webContents.send("load-player", new Player(d[x], username, database["players"][d[x]]["platform"], "-1", database["players"][d[x]]["games"]), database["sessions"]);
			return;
		}
	}
});

ipcMain.on("database-reset", function (e) {
	database = { sessions: {}, players: {} };
	writeFile("database.json", JSON.stringify(database));
});

ipcMain.on("add-replay", function (e) {
	dialog.showOpenDialog({ properties: ["openFile"], defaultPath: resolveToAbsolutePath("%LOCALAPPDATA%\\FortniteGame\\Saved\\Demos") })
		.then((e) => {
			if (!e.canceled && e.filePaths.length > 0) execFile("ReplayParser.exe", [e.filePaths]);
		});
});

ipcMain.on('display-stats', function (e) {
	if (Object.keys(database["sessions"]).length == 0) return;
	async function send() {
		var players = [], playerList = JSON.parse(await readFile("playerList.json")), d;
		for (var x = 0; x < playerList["players"].length; x++) {
			d = database["players"][playerList["players"][x][1]];
			if (d["games"].length >= config["snipeCounts"]) players.push(new Player(playerList["players"][x][1], d["username"], d["platform"], playerList["players"][x][0], d["games"]));
		}
		win.webContents.send("display-stats", players, playerList["stats"], database["sessions"], [playerList["players"].length + 1, playerList["totalPlayers"]]);
	}
	send();
});

ipcMain.on("display-feed", function (e) {
	if (Object.keys(database["sessions"]).length == 0) return;
	async function send() {
		var players = [], playerList = JSON.parse(await readFile("playerList.json")), d;
		for (var x = 0; x < playerList["players"].length; x++) {
			d = database["players"][playerList["players"][x][1]];
			players.push(new Player(playerList["players"][x][1], d["username"], d["platform"], playerList["players"][x][0], d["games"]));
		}
		players.push(new Player(playerList["owner"], "YOU", "WIN", playerList["team"]));
		win.webContents.send("display-feed", players, playerList["killfeed"]);
	}
	send();
});

ipcMain.on('display-snipers', function (e) {
	if (Object.keys(database["sessions"]).length == 0) return;
	async function send() {
		var players = Object.keys(database["players"]), snipers = [];
		for (var x = 0; x < players.length; x++) {
			if (database["players"][players[x]].games.length >= config["snipeCounts"]) snipers.push(new Player(players[x], database["players"][players[x]].username, database["players"][players[x]].platform, "-1", database["players"][players[x]].games));
		}
		snipers = snipers.reverse();
		win.webContents.send("display-snipers", snipers, database["sessions"]);
	}
	send();
});

ipcMain.on('display-placements', function (e) {
	if (Object.keys(database["sessions"]).length == 0) return;
	async function send() {
		function playerCompare( a, b ) {
			if ( a["placement"] < b["placement"] ){
				return -1;
			}
			if ( a["placement"] > b["placement"] ){
				return 1;
			}
			return 0;
		}
		function placementWinCheck(placeList) {
			for (var x = placeList.length - 1; x >= 0; x--) {
				if (placeList[x]["placement"] == 0) {
					break;
				}
			}
			var baseline = placeList[x + 1]["placement"];
			for (var y = [x + 1]; y < placeList.length; y++) {
				placeList[y]["placement"] = baseline;
				baseline ++;
			}
			for (var x = 0; x < placeList.length; x++) {
				if (placeList[x]["placement"] == 0 && placeList[x]["members"].split(",")[0] == "BOT") placeList[x]["placement"] = 999	;
				else if (placeList[x]["placement"] != 0) break;
			}
			for (var x = 0; x < placeList.length; x++) {
				if (placeList[x]["placement"] == 1) {
					var y = 0;
					while (placeList[y]["placement"] == 0 || placeList[y]["placement"] == 999) {
						if (placeList[y]["placement"] != 999) placeList[y]["placement"] = placeList[placeList.length - 1]["placement"] + 1;
						y++;
					}
					break;
				}
			}
			return placeList;
		}
		var players = [], playerList = JSON.parse(await readFile("playerList.json")), d;
		for (var x = 0; x < playerList["players"].length; x++) {
			d = database["players"][playerList["players"][x][1]];
			players.push(new Player(playerList["players"][x][1], d["username"], d["platform"], playerList["players"][x][0], d["games"]));
		}
		players.push(new Player(playerList["owner"], "YOU", "WIN", playerList["team"]));
		win.webContents.send("display-placements", players, placementWinCheck(playerList["placements"].sort(playerCompare)));
	}
	send();
});

/* Auxiliary functions */

function logMessage(line) {
	win.webContents.send("log-entry", line);
}

function progress(value) {
	win.webContents.send("progress", value);
}

function resolveToAbsolutePath(path) {
	return path.replace(/%([^%]+)%/g, function (_, key) {
		return process.env[key];
	});
}

async function feedLogger() {
	function getPlayer(players, target) {
		for (var x = 0; x < players.length; x++) {
			if (String(players[x].id) == String(target)) return players[x];
		}
	}
	function botEntry(bot) {
		return new Player("AI", bot, "N/A", "-1");
	}
	var players = [], playerList = JSON.parse(await readFile("playerList.json")), killfeed = playerList["killfeed"], lines = "Time,Team,Killer,Action,Team,Killed,Weapon\n";
	for (var x = 0; x < playerList["players"].length; x++) {
		d = database["players"][playerList["players"][x][1]];
		players.push(new Player(playerList["players"][x][1], d["username"], d["platform"], playerList["players"][x][0], d["games"]));
	}
	players.push(new Player(playerList["owner"], "YOU", "WIN", playerList["team"]));
	for (var x = 0; x < killfeed.length; x++) {
		if (killfeed[x][0].length == 3) killer = botEntry(killfeed[x][0]);
		else killer = getPlayer(players, killfeed[x][0]);
		if (killfeed[x][1].length == 3) killed = botEntry(killfeed[x][1]);
		else killed = getPlayer(players, killfeed[x][1]);
		if (killfeed[x][3]) action = "knocked";
		else action = "killed";
		lines += [killfeed[x][4], killer.team, [killer.username], action, killed.team, [killed.username], killfeed[x][2]].join(",") + "\n";
	}
	writeFile("killfeed.csv", lines, {encoding: "utf8"});
}

async function pullUsername(id) {
	return (await client.getProfile(id)).displayName;
}

async function fixNullNames() {
	p = Object.keys(database["players"]), username;
	for (var x = 0; x < p.length; x++) {
		if (database[p[x]]["username"] == null) {
			username = await pullUsername(p[x]);
			if (username == null) logMessage(`Error pulling username for ${p[x]}.`);
			else logMessage(`Updated username for ${username} (ID: ${p[x]}).`);
		}
	}
}

async function parseReplay() {
	barMoving = true;
	var playerList = JSON.parse(await readFile("playerList.json")), id, platform, session = playerList["session"];
	if (database["sessions"][session]) {
		logMessage("Duplicate replay detected, reloading information...");
		return;
	}
	else logMessage(`Parsing information for '${playerList["file"]}'...`);
	database["sessions"][session] = {
		"file": playerList["file"], // MAKE SURE THIS DOESN'T READ THE FULL FILE PATH ----------------------------------------------------------------------------------------
		"time": playerList["time"]
	};
	for (var x = 0; x < playerList["players"].length; x++) {
		id = playerList["players"][x][1];
		platform = playerList["players"][x][2];
		if (database["players"][id]) {
			database["players"][id]["platform"] = platform; // update with their latest platform
			database["players"][id]["games"].push(session);
		}
		else {
			database["players"][id] = {
				"username" : await pullUsername(id),
				"platform" : platform,
				"games": [session]
			};
		}
		progress(x / playerList["players"].length * 100);
	}
	progress(100);
	if (logFeed) feedLogger();
	logMessage(`Completed analysis for '${playerList["file"]}'.`);
	win.webContents.send("replay-loaded");
	setTimeout(() => { progress(0); barMoving = false; }, 1500);
	writeFile("database.json", JSON.stringify(database));
}

/*
JSON Structures

This is generated by the replay parser program
playerList {
	"owner" : "{owner id}",
	"team" : {NUMBER},
	"file" : "{replay name}",
	"session" : "{id of the game session}",
	"time" : "{starting time of that game}",
	"totalPlayers" : {# for total real players in that lobby},
	"players" : [
		[
			{team number},
			{bool if they're a teammate},
			{player id},
			{platform, pc, switch, etc.}
		]
		repeating...
	],
	"killfeed" : [
		[
			"{killer}",
			"{killed}",
			"{weapon}",
			"{is a knock}",
			"{time of death}",
			"{death tags, this is for diagnostic purposes}"
		]
		repeating...
	],
	"stats" : {
		"kills": {num kills},
		"assists": {num assists},
		"accuracy": {accuracy percentage},
		"dealt": {damage dealt},
		"taken": {damage taken},
		"distance": {distance traveled in cm}
	},
	"placements": [
		{
			"team": {team num},
			"placement": {highest placement of any team member},
			"members": {string of comma delimited team member id's},
			"kills": {team kills}
		},
		repeating...
}

this is generated in here
database {
	"sessions" : {
		"{game id}" : {
			"file": "name of replay file",
			"time": "date the replay was created"
		},
		repeating...
	},
	"players" : {
		"id": {
			"username" : "{epic ign for the player, if it was retrieved, otherwise null}",
			"platform" : "{pc, switch, etc.}",
			"games": [
				"{game session id A that they were with you in}",
				"{game session id B}"
			]
		},
		repeating...
	}
}
*/