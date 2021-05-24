using FortniteReplayReader;
using Unreal.Core.Models.Enums;
using System.IO;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json;

namespace ReplayParser {
	class Program {
		private static string gunTag(byte gunByte) {
			string cause = "N/A";
			switch ((int)gunByte) {
				case 0:
					cause = "Storm";
					break;
				case 1:
					cause = "Fall";
					break;
				case 8:
					cause = "Pickaxe";
					break;
				case 16:
					cause = "Trap";
					break;
				case 17:
					cause = "Bleedout";
					break;
				case 23:
					cause = "Vehicle";
					break;
				case 27:
				case 28:
					cause = "Plane";
					break;
				case 50:
					cause = "Disconnect";
					break;
			}
			return cause;
		}
		// Credits to SlxTnT for this
		private static string UpdateDeathTag(System.Collections.Generic.IEnumerable<string> DeathTags) {
			string ItemType = "N/A";

			if (DeathTags == null) {
				return ItemType = "NULL";
			}

			foreach (string deathTag in DeathTags) {
				switch (deathTag) {
					case "Pawn.Athena.DoNotDisplayInKillFeed":
						break;
					case "Weapon.Melee.Impact.Pickaxe":
						ItemType = "Pickaxe";
						break;
					case "weapon.ranged.assault.burst":
					case "weapon.ranged.assault.standard":
					case "Weapon.Ranged.Assault.Heavy":
					case "weapon.ranged.assault.silenced":
						ItemType = "Rifle";
						break;
					case "weapon.ranged.heavy.rocket_launcher":
						ItemType = "RocketLauncher";
						break;
					case "weapon.ranged.pistol":
					case "Weapon.Ranged.Pistol.Standard":
					case "Item.Weapon.Ranged.Pil.Tracker":
						ItemType = "Pistol";
						break;
					case "Weapon.Ranged.Shotgun.Pump":
					case "Item.Weapon.Ranged.Shotgun.Tactical":
					case "Weapon.Ranged.Shotgun.Tactical":
					case "Item.Weapon.Ranged.Shotgun.Dub":
						ItemType = "Shotgun";
						break;
					case "Item.Weapon.Ranged.SMG.PDW":
					case "Item.Weapon.Ranged.SMG.Suppressed":
						ItemType = "SMG";
						break;
					case "weapon.ranged.sniper.bolt":
					case "phoebe.items.SuppressedSniper":
						ItemType = "Sniper";
						break;
					case "Abilities.Generic.M80":
						ItemType = "Grenade";
						break;
					case "phoebe.items.harpoon":
						ItemType = "Harpoon";
						break;
					case "phoebe.weapon.ranged.minigun":
						ItemType = "Minigun";
						break;
					case "Weapon.Ranged.Heavy.C4":
						ItemType = "C4";
						break;
					case "Gameplay.Damage.Physical.Energy":
						ItemType = "Storm";
						break;
					case "DeathCause.LoggedOut":
					case "DeathCause.RemovedFromGame":
						ItemType = "Disconnect";
						break;
					case "Asset.Athena.EnvItem.Sentry.Turret.Damage":
						ItemType = "SentryTurret";
						break;
					case "Gameplay.Damage.Environment":
					case "EnvItem.ReactiveProp.GasPump":
						ItemType = "Environment";
						break;
					case "Gameplay.Damage.Environment.Falling":
						ItemType = "Fall";
						break;
					case "Item.Trap.DamageTrap":
						ItemType = "Trap";
						break;
					case "Item.Weapon.Ranged.Launcher.Junkgun":
					case "Weapon.Ranged.Heavy.Junkgun":
						ItemType = "JunkGun";
						break;
					case "Item.Weapon.Ranged.Bow.Scrap":
					case "Item.Weapon.Ranged.Bow.Metal":
					case "Item.Weapon.Ranged.Bow.Bone":
					case "Item.Weapon.Ranged.Bow.Flame":
					case "Item.Weapon.Ranged.Bow.Shockwave":
					case "Item.Weapon.Ranged.Bow.ClusterBomb":
					case "Item.Weapon.Ranged.Bow.Stink":
					case "Item.Weapon.Ranged.Bow.Grappler":
						ItemType = "Bow";
						break;
					case "Pawn.Athena.NPC.Wildlife.Predator.SpicySake":
						ItemType = "Shark";
						break;
					case "Pawn.Athena.NPC.Wildlife.Predator.Robert":
						ItemType = "Raptor";
						break;
					case "Pawn.Athena.NPC.Wildlife.Predator.Grandma":
						ItemType = "Wolf";
						break;
					case "Gameplay.Damage.Elemental.Fire":
						ItemType = "Fire";
						break;
					case "Gameplay.Effect.InstantDeath.Environment.UnderLandscape":
						ItemType = "InstantEnvironmentUnderLandscape";
						break;
					case "Gameplay.Effect.InstantDeath.Environment":
						ItemType = "InstantEnvironment";
						break;
					case "Gameplay.Effect.InstantDeath":
						ItemType = "InstantDeath";
						break;
					case "Item.Weapon.Ranged.Launcher.Egg":
						ItemType = "Egg Launcher";
						break;
					case "Gameplay.Damage.Physical.Explosive":
					case "EnvItem.ReactiveProp.PropaneTank":
					case "Gameplay.Damage.Physical.Explosive.Gas":
					case "Item.Fuel.PetrolPickup":
						ItemType = "Explosive";
						break;
					case "Item.Weapon.Vehicle.Meatball":
						ItemType = "Boat";
						break;
					case "phoebe.weapon.ranged.smg": // Super general weapon cases after in case nothing above catches
						ItemType = "SMG";
						break;
					case "phoebe.weapon.ranged.rifle":
						ItemType = "Rifle";
						break;
					case "phoebe.weapon.ranged.shotgun":
						ItemType = "Shotgun";
						break;
					case "phoebe.weapon.ranged.pistol":
						ItemType = "Pistol";
						break;
				}
				if (ItemType != "N/A") break;
			}
			return ItemType;
		}
		private static bool StringContains(string[] stringArray, string key) {
			foreach (string value in stringArray) if (value == key) return true;
			return false;
		}
		static void Main(string[] args) {
			var file = args[0];
			var reader = new ReplayReader(null, ParseMode.Full);
			var replay = reader.ReadReplay(file);
			string owner = "", session = replay.GameData.GameSessionId, timeStart = replay.Info.Timestamp.ToString();
			string[] reals = new string[200];
			int team = 0, totalPlayers = 0, x = 0;
			file = file.Split("/")[file.Split("/").Length - 1];
			file = file.Split("\\")[file.Split("\\").Length - 1];
			JObject playerList = new JObject();
			JObject stats = new JObject();
			JArray placements = new JArray();
			JArray players = new JArray();
			JArray killfeed = new JArray();

			/* Real Player Count */
			foreach (var player in replay.PlayerData) {
				if (player.EpicId != null && player.EpicId != "") {
					if (owner == "" && player.IsReplayOwner) {
						owner = player.EpicId.ToLower();
						team = (int)player.TeamIndex - 2;
					}
					reals[x] = player.EpicId;
					x++;
				}
				if (player.TeamIndex > 2 && player.PlayerId != null) totalPlayers += 1;
			}

			/* Player List Processing */
			foreach (var player in replay.PlayerData) {
				JArray tempPlayer = new JArray();
				if (player.EpicId != null && player.EpicId != "" && player.TeamIndex > 2 && player.EpicId.ToLower() != owner) {
					tempPlayer.Add((player.TeamIndex - 2).ToString());
					tempPlayer.Add(player.EpicId.ToLower());
					tempPlayer.Add(player.Platform);
					players.Add(tempPlayer);
				}
			}

			/* Kill Feed Processing */
			string killer, killed, death, tod;
			bool knocked;
			x = 0;
			foreach (var kill in replay.Eliminations) {
				JArray tempKill = new JArray();
				if (kill.Eliminator != "Bot" && StringContains(reals, kill.Eliminator)) killer = kill.Eliminator.ToLower();
				else if (kill.Eliminator == "Bot") killer = "NPC";
				else killer = "bot";
				if (kill.Eliminated != "Bot" && StringContains(reals, kill.Eliminated)) killed = kill.Eliminated.ToLower();
				else if (kill.Eliminated == "Bot") killed = "NPC";
				else killed = "bot";
				while (x < replay.KillFeed.Count && replay.KillFeed[x].DeathTags == null && (replay.KillFeed[x].FinisherOrDownerName == killer || replay.KillFeed[x].PlayerName == killed)) x++;
				death = gunTag(kill.GunType) == "N/A" ? UpdateDeathTag(replay.KillFeed[x].DeathTags) : gunTag(kill.GunType);
				tod = kill.Time;
				knocked = kill.Knocked;
				tempKill.Add(killer);
				tempKill.Add(killed);
				tempKill.Add(death);
				tempKill.Add(knocked);
				tempKill.Add(tod);
				tempKill.Add(replay.KillFeed[x].DeathTags);
				killfeed.Add(tempKill);
			}

			/* Stats Processing */
			stats["kills"] = replay.Stats.Eliminations;
			stats["assists"] = replay.Stats.Assists;
			stats["accuracy"] = replay.Stats.Accuracy * 100;
			stats["dealt"] = replay.Stats.DamageToPlayers;
			stats["taken"] = replay.Stats.DamageTaken;
			stats["distance"] = replay.Stats.TotalTraveled;

			/* Placements Processing */
			foreach (var ranks in replay.TeamData) {
				if (ranks.TeamIndex > 2) {
					JObject tempTeam = new JObject();
					tempTeam["team"] = ranks.TeamIndex - 2;
					tempTeam["placement"] = ranks.Placement == null ? 0 : ranks.Placement;
					tempTeam["members"] = (string.Join(",", ranks.PlayerNames)).ToLower();
					tempTeam["kills"] = ranks.TeamKills == null ? 0 : ranks.TeamKills;
					placements.Add(tempTeam);
				}
            }

			/* Final JSON compilation */
			playerList["owner"] = owner;
			playerList["team"] = team;
			playerList["file"] = file;
			playerList["session"] = session;
			playerList["time"] = timeStart;
			playerList["totalPlayers"] = totalPlayers;
			playerList["players"] = players;
			playerList["killfeed"] = killfeed;
			playerList["stats"] = stats;
			playerList["placements"] = placements;
			using (StreamWriter path = File.CreateText(@"playerList.json"))
			using (JsonTextWriter writer = new JsonTextWriter(path)) playerList.WriteTo(writer);
		}
	}
}

/*
playerList {
	"owner" : "{owner id}",
	"team" : {NUMBER},
	"file" : "{replay name}",
	"session" : "{id of the game session}",
	"time" : "{starting time of that game}", 12/9/2020 12:17:51 AM
	"totalPlayers" : {# for total real players in that lobby},
	"players" : [
		[
			{team number},
			{bool if they're a teammate},
			{player id},
			{platform, pc, switch, etc.}
		],
		[
			repeating....
		]
	],
	"killfeed" : [
		[
			"{killer}",
			"{killed}",
			"{weapon}",
			"{is a knock}",
			"{time of death}",
			"{weapon killed ID, this is for diagnostic purposes}"
		],
		[
			repeating....
		]
	]
}
*/
