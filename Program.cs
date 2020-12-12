using FortniteReplayReader;
using Unreal.Core.Models.Enums;
using System.IO;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json;

namespace ReplayParser
{
    class Program
    {
		private static string gunTag(byte gunByte) {
			string cause = "null";
			switch ((int)gunByte) {
				case 0:
					cause = "Storm";
					break;
				case 1:
					cause = "Fall";
					break;
				case 2:
					cause = "Pistol";
					break;
				case 3:
					cause = "Shotgun";
					break;
				case 4:
					cause = "Rifle";
					break;
				case 5:
					cause = "SMG";
					break;
				case 6:
					cause = "Sniper";
					break;
				case 7:
					cause = "Sniper";
					break;
				case 8:
					cause = "Pickaxe";
					break;
				case 10:
					cause = "Explosive";
					break;
				case 11:
					cause = "Explosive";
					break;
				case 12:
					cause = "Explosive";
					break;
				case 13:
					cause = "Explosive";
					break;
				case 14:
					cause = "Minigun";
					break;
				case 15:
					cause = "Bow";
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
				case 30:
					cause = "Stink";
					break;
				case 32:
					cause = "Turret";
					break;
				case 50:
					cause = "Disconnect";
					break;
            }
			return cause;
        }
		// Credits to SlxTnT for this
		private static string updateDeathTag(System.Collections.Generic.IEnumerable<string> DeathTags) {
			string ItemType = "null";

			if (DeathTags == null) {
				return ItemType;
			}

			foreach (string deathTag in DeathTags) {
				switch (deathTag) {
					case "Pawn.Athena.DoNotDisplayInKillFeed":
						break;
					case "Weapon.Melee.Impact.Pickaxe":
						ItemType = "PickAxe";
						break;
					case "weapon.ranged.assault.burst":
						ItemType = "BurstRifle";
						break;
					case "weapon.ranged.assault.standard":
						ItemType = "AssaultRifle";
						break;
					case "weapon.ranged.assault.silenced":
						ItemType = "SuppressedAR";
						break;
					case "weapon.ranged.heavy.rocket_launcher":
						ItemType = "RocketLauncher";
						break;
					case "weapon.ranged.pistol":
						ItemType = "Pistol";
						break;
					case "Weapon.Ranged.Pistol.Standard":
						ItemType = "Pistol";
						break;
					case "Weapon.Ranged.Shotgun.Pump":
						ItemType = "PumpShotgun";
						break;
					case "Weapon.Ranged.Shotgun.Tactical":
						ItemType = "TacticalShotgun";
						break;
					case "Item.Weapon.Ranged.SMG.PDW":
						ItemType = "SMG";
						break;
					case "Item.Weapon.Ranged.SMG.Suppressed":
						ItemType = "SuppressedSMG";
						break;
					case "weapon.ranged.sniper.bolt":
						ItemType = "BoltSniper";
						break;
					case "phoebe.items.SuppressedSniper":
						ItemType = "SuppressedSniper";
						break;
					case "Abilities.Generic.M80":
						ItemType = "Grenade";
						break;
					case "Weapon.Ranged.Assault.Heavy":
						ItemType = "HeavyAR";
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
						ItemType = "Disconnect";
						break;
					case "DeathCause.RemovedFromGame":
						ItemType = "Disconnect";
						break;
					case "Asset.Athena.EnvItem.Sentry.Turret.Damage":
						ItemType = "SentryTurret";
						break;
					case "Gameplay.Damage.Environment":
						ItemType = "Environment";
						break;
					case "EnvItem.ReactiveProp.GasPump":
						ItemType = "Environment";
						break;
					case "Gameplay.Damage.Environment.Falling":
						ItemType = "Falling";
						break;
					case "Item.Trap.DamageTrap":
						ItemType = "Trap";
						break;
				}
			}
			return ItemType;
		}
		private static bool stringContains(string[] stringArray, string key) {
			foreach (string value in stringArray) {
				if (value == key) {
					return true;
                }
            }
			return false;
        }
        static void Main(string[] args)
        {
            var replayFile = args[0];
            var reader = new ReplayReader(null, ParseMode.Full);
			var replay = reader.ReadReplay(replayFile);
			string owner = "", session = replay.GameData.GameSessionId, file = args[0].Split("/")[args[0].Split("/").Length - 1], timeStart = replay.Info.Timestamp.ToString();
			string[] reals = new string[100];
			int team = 0, totalPlayers = 0, x = 0;
			JObject playerList = new JObject();
			JArray players = new JArray();
			JArray killfeed = new JArray();
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
			foreach (var player in replay.PlayerData) {
				JArray tempPlayer = new JArray();
				if (player.EpicId != null && player.EpicId != "" && player.TeamIndex > 2 && player.EpicId.ToLower() != owner) {
					tempPlayer.Add((player.TeamIndex - 2).ToString());
					tempPlayer.Add(player.TeamIndex - 2 == team);
					tempPlayer.Add(player.EpicId.ToLower());
					tempPlayer.Add(player.Platform);
					players.Add(tempPlayer);
				}
            }
			string killer, killed, death, deathDiagnostic, tod;
			bool knocked;
			x = 0;
			foreach (var kill in replay.Eliminations) {
				JArray tempKill = new JArray();
				if (kill.Eliminator != "Bot" && stringContains(reals, kill.Eliminator)) killer = kill.Eliminator.ToLower();
				else if (kill.Eliminator == "Bot") killer = "NPC";
				else killer = "bot";
				if (kill.Eliminated != "Bot" && stringContains(reals, kill.Eliminated)) killed = kill.Eliminated.ToLower();
				else if (kill.Eliminated == "Bot") killed = "NPC";
				else killed = "bot";
				death = gunTag(kill.GunType);
				if (death == "null") death = updateDeathTag(replay.KillFeed[x].DeathTags);
				deathDiagnostic = kill.GunType.ToString();
				tod = kill.Time;
				knocked = kill.Knocked;
				if (replay.KillFeed[x].DeathTags != null) {
					foreach (var cause in replay.KillFeed[x].DeathTags) {
						deathDiagnostic += "\n" + cause;
					}
				}
				x++;
				tempKill.Add(killer);
				tempKill.Add(killed);
				tempKill.Add(death);
				tempKill.Add(knocked);
				tempKill.Add(tod);
				tempKill.Add(deathDiagnostic);
				killfeed.Add(tempKill);
			}
			playerList["owner"] = owner;
			playerList["team"] = team;
			playerList["file"] = file;
			playerList["session"] = session;
			playerList["time"] = timeStart;
			playerList["totalPlayers"] = totalPlayers;
			playerList["players"] = players;
			playerList["killfeed"] = killfeed;
			using (StreamWriter path = File.CreateText(@"playerList.json"))
			using (JsonTextWriter writer = new JsonTextWriter(path)) {
				playerList.WriteTo(writer);
			}
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