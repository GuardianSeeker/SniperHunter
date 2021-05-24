const { ipcRenderer, shell, remote, session } = require("electron");
var Player = require("./player.js");

/* Send functions */
function getStats() { ipcRenderer.send("display-stats"); }

function getFeed() { ipcRenderer.send("display-feed"); }

function getSnipers() { ipcRenderer.send("display-snipers"); }

function getPlacements() { ipcRenderer.send("display-placements"); }

function openProfile(username, event) { ipcRenderer.send("load-player", username); }

/* Recieve functions */

ipcRenderer.on("replay-loaded", function (e) {
	getStats();
});

ipcRenderer.on("progress", function (e, value) {
	var bar = document.getElementById("progress");
	bar.style.width = `${value}%`;
	if (value == 100) bar.style.opacity = 0.3;
	else if (bar.style.opacity != 1) bar.style.opacity = 1;
});

ipcRenderer.on("database-reset", function (e) {
	var reply = confirm("This will reset all the sniper data, confirm?");
	if (reply) ipcRenderer.send("database-reset");
});

ipcRenderer.on("display-stats", function (e, players, stats, sessions, botcount) {
	function numberWithCommas(x) { return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
	var tdiv = document.getElementById("tables"), statsdiv = document.createElement("div"), table = createTable(["EPIC ID", "Platform", "Team", "Username", "Snipe Count", "Last Seen"]), tbody = document.createElement("tbody");
	tdiv.innerHTML = "";
	tdiv.appendChild(statsdiv);
	tdiv.appendChild(table);
	table.appendChild(tbody);
	statsdiv.style.paddingLeft = "15px";
	for (var x = 0; x < players.length; x++) {
		tbody.appendChild(createRow([players[x].id, players[x].platform, players[x].team, [players[x].username], players[x].games.length, getSession(sessions, players[x].games[players[x].games.length - 2])["time"]]));
	}
	if (stats["kills"] != "N/A") statsdiv.innerHTML = `<h3 style="margin: 4px 0px 4px -8px;">Stats</h3>Kills → ${stats["kills"]}<br>Assists → ${stats["assists"]}<br>Accuracy → ${stats["accuracy"].toFixed(2)}%<br>Damage Dealt → ${numberWithCommas(stats["dealt"])}<br>Damage Taken → ${numberWithCommas(stats["taken"])}<br>Distance Travelled → ${numberWithCommas((stats["distance"] / 100).toFixed(2))} m<br>Real Players: ${botcount[0]}/${botcount[1]}<br><h3 style="margin: 4px 0px 4px -8px;">Snipers</h3>`;
	else if (stats["kills"] != "N/A") statsdiv.innerHTML = `<h3 style="margin: 4px 0px 4px -8px;">Stats</h3>Kills → ${stats["kills"]}<br>Assists → ${stats["assists"]}<br>Accuracy → ${stats["accuracy"]}%<br>Damage Dealt → ${stats["dealt"]}<br>Damage Taken → ${stats["taken"]}<br>Distance Travelled → ${stats["distance"]} m<br>Real Players: ${botcount[0]}/${botcount[1]}<br><h3 style="margin: 4px 0px 4px -8px;">Snipers</h3>`;
	$(table).DataTable({
		ordering: true,
		order: [[4, "desc"]],
		searching: true,
		paging: false,
		autoWidth: true,
		stripeClasses: ["", ""],
		info: false
	});
});

ipcRenderer.on("display-feed", function (e, players, killfeed) {
	var tdiv = document.getElementById("tables"), table = createTable(["Time", "Team", "Killer", "Action", "Team", "Killed", "Weapon"]), tbody = document.createElement("tbody"), killer, killed, action;
	tdiv.innerHTML = "";
	tdiv.appendChild(table);
	table.appendChild(tbody);
	for (var x = 0; x < killfeed.length; x++) {
		if (killfeed[x][0].length == 3) killer = botEntry(killfeed[x][0]);
		else killer = getPlayer(players, killfeed[x][0]);
		if (killfeed[x][1].length == 3) killed = botEntry(killfeed[x][1]);
		else killed = getPlayer(players, killfeed[x][1]);
		if (killfeed[x][3]) action = "knocked";
		else action = "killed";
		tbody.appendChild(createRow([killfeed[x][4], killer.team, [killer.username], action, killed.team, [killed.username], killfeed[x][2]]));
	}
	$(table).DataTable({
		ordering: true,
		searching: true,
		paging: false,
		autoWidth: true,
		stripeClasses: ["", ""],
		info: false
	});
});

ipcRenderer.on("display-snipers", function (e, snipers, sessions) {
	var tdiv = document.getElementById("tables"), table = createTable(["Snipe Count", "EPIC ID", "Platform", "Username", "Last Seen"]), tbody = document.createElement("tbody");
	tdiv.innerHTML = "";
	tdiv.appendChild(table);
	table.appendChild(tbody);
	for (var x = 0; x < snipers.length; x++) {
		tbody.appendChild(createRow([snipers[x].games.length, snipers[x].id, snipers[x].platform, [snipers[x].username], getSession(sessions, snipers[x].games[snipers[x].games.length - 1]).time]));
	}
	$(table).DataTable({
		ordering: true,
		order: [[0, "desc"]],
		searching: true,
		paging: false,
		autoWidth: true,
		stripeClasses: ["", ""],
		info: false
	});
});

ipcRenderer.on("display-placements", function (e, players, placements) {
	function getTeamNames(players, names) {
		var nameString = [];
		names = names.split(",");
		if (names.length > 6) return "Names hidden due to large team size.";
		for (var x = 0; x < names.length; x++) {
			if (names[x] == "BOT") nameString.push(botEntry("BOT").username);
			else nameString.push(getPlayer(players, names[x]).username);
		}
		return nameString;
	}
	var tdiv = document.getElementById("tables"), table = createTable(["Placement", "Team", "Members", "Kills"]), tbody = document.createElement("tbody");
	tdiv.innerHTML = "";
	tdiv.appendChild(table);
	table.appendChild(tbody);
	for (var x = 0; x < placements.length; x++) {
		tbody.appendChild(createRow([placements[x]["placement"], placements[x]["team"], getTeamNames(players, placements[x]["members"]), placements[x]["kills"]]));
	}
	$(table).DataTable({
		ordering: true,
		searching: true,
		paging: false,
		autoWidth: true,
		stripeClasses: ["", ""],
		info: false
	});
});

ipcRenderer.on("log-entry", function (e, message) {
	var log = document.getElementById("logspace"), entry = document.createElement("li");
	entry.appendChild(document.createTextNode(message));
	if (log.childNodes.length == 0) log.appendChild(entry);
	else log = log.insertBefore(entry, log.childNodes[0]);
});

ipcRenderer.on("load-player", function (e, player, sessions) {
	var tdiv = document.getElementById("tables"), statsdiv = document.createElement("div"), table = createTable(["Time", "Game ID", "File Name"]), tbody = document.createElement("tbody"), s;
	tdiv.innerHTML = "";
	tdiv.appendChild(statsdiv);
	tdiv.appendChild(table);
	table.appendChild(tbody);
	statsdiv.style.paddingLeft = "15px";
	for (var x = 0; x < player.games.length; x++) {
		s = getSession(sessions, player.games[x]);
		tbody.appendChild(createRow([s["time"], player.games[x], s["file"]]));
	}
	statsdiv.innerHTML = `<h3 style="margin: 4px 0px 4px -8px;">${player.username}</h3>ID → ${player.id}<br>Platform → ${player.platform}<br><p class="button" style="width: 250px;" onclick="trackerProfile('${player.username}')">Open on Fortnite Tracker</p><h3 style="margin: 4px 0px 4px -8px;">History</h3>`;
	$(table).DataTable({
		ordering: true,
		searching: true,
		paging: false,
		autoWidth: true,
		stripeClasses: ["", ""],
		info: false
	});
});

/* Utility functions */

function trackerProfile(username) {
	shell.openExternal(`https://fortnitetracker.com/profile/all/${username}`, {activate: true});
}

function getPlayer(players, target) {
	for (var x = 0; x < players.length; x++) {
		if (String(players[x].id) == String(target)) return players[x];
	}
}

function getSession(sessions, target) {
	var s = Object.keys(sessions);
	if (s.indexOf(target) != -1) return sessions[target];
}

function botEntry(bot) {
	return new Player("AI", bot, "N/A", "-1");
}

function createTable(headings) {
	var t = document.createElement("table"), thead =  document.createElement("thead"), h = document.createElement("tr"), th;
	t.appendChild(thead);
	thead.appendChild(h);
	h.className = "noselect";
	for (var x = 0; x < headings.length; x++) {
		th = document.createElement("th");
		th.appendChild(document.createTextNode(headings[x]));
		h.appendChild(th);
	}
	return t;
}

function createRow(entries) {
	var r = document.createElement("tr"), td, a;
	for (var x = 0; x < entries.length; x++) {
		td = document.createElement("td");
		if (Array.isArray(entries[x])) {
			for (var y = 0; y < entries[x].length; y++) {
				if (entries[x][y].length > 3) {
					a = document.createElement("span");
					a.appendChild(document.createTextNode(entries[x][y]));
					a.className = "profile";
					a.addEventListener("click", openProfile.bind(null, entries[x][y]));
					td.appendChild(a);
				}
				else td.appendChild(document.createTextNode(entries[x][y]));
				if (y != entries[x].length - 1) td.appendChild(document.createTextNode(", "));
			}
		}
		else td.appendChild(document.createTextNode(entries[x]));
		r.appendChild(td);
	}
	return r;
}

function resolveToAbsolutePath(path) {
	return path.replace(/%([^%]+)%/g, function (_, key) {
		return process.env[key];
	});
}

function addReplay() {
	ipcRenderer.send("add-replay");
}