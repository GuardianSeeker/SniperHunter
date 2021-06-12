using FortniteReplayReader;
using FortniteReplayReader.Models;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Linq;
using System.Collections.Generic;
using System.IO;
using Unreal.Core.Models.Enums;

namespace ReplayParser
{
	class Program
	{
		private static bool StringContains(List<string> list, string target) {
			if (list == null || target == null) return false;
			foreach (string l in list) if (l == target) return true;
			return false;
        }
		// Credits to SlxTnT for this
		private static string UpdateDeathTag(System.Collections.Generic.IEnumerable<string> DeathTags) {
			string ItemType = "N/A";

			if (DeathTags == null) {
				return ItemType = "N/A";
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
					case "Item.Weapon.Ranged.Sniper.ReactorGrade":
						ItemType = "Railgun";
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
					case "Ability.Passive.SurfaceChange":
						ItemType = "Lava";
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
		private static string TimeofDeath(float DeltaTimeGameSeconds) {
			return TimeSpan.FromSeconds((int)DeltaTimeGameSeconds).ToString(@"mm\:ss");
        }
		static void Main(string[] args)
		{
			var reader = new ReplayReader();
			var file = args[0];
			var replay = reader.ReadReplay(file, ParseType.Full);
			file = file.Split("/")[file.Split("/").Length - 1];
			file = file.Split("\\")[file.Split("\\").Length - 1];
			int real = 0, totalPlayers = 0, team = -1;
			string owner = "", session = replay.GameInformation.GameState.SessionId, timeStart = replay.Info.Timestamp.ToString();
			JObject playerList = new JObject();
			JArray players = new JArray();
			JArray killFeed = new JArray();
			JObject stats = new JObject();
			JArray placements = new JArray();
			
			/* Real Player & Player List Processing */
			foreach (var player in replay.GameInformation.Players) {
				if (player.Teamindex > 2) totalPlayers++;
				if (player.IsPlayersReplay) {
					owner = player.EpicId.ToLower();
					team = player.Teamindex - 2;
				}
				else if (!player.IsBot && player.EpicId != null) {
					JArray t = new JArray();
					t.Add(player.Teamindex - 2);
					t.Add(player.EpicId.ToLower());
					t.Add(player.Platform);
					players.Add(t);
					real++;
				}
			}
			
			/* Kill Feed Processing */
			string killer, killed;
			foreach (var kill in replay.GameInformation.KillFeed) {			
				if (kill.FinisherOrDowner != null && kill.Player != null && (kill.CurrentPlayerState == PlayerState.Killed || kill.CurrentPlayerState == PlayerState.Knocked || kill.CurrentPlayerState == PlayerState.BleedOut || kill.CurrentPlayerState == PlayerState.FinallyEliminated)) {
					JArray t = new JArray();
					if (kill.FinisherOrDowner.Teamindex <= 2) killer = "NPC";
					else killer =  kill.FinisherOrDowner.IsBot ? "BOT" : kill.FinisherOrDowner.EpicId == null ? "bad id" : kill.FinisherOrDowner.EpicId.ToLower();
					if (kill.Player.Teamindex <= 2) killed = "NPC";
					else killed = kill.Player.IsBot ? "BOT" : kill.Player.EpicId.ToLower();
					t.Add(killer);
					t.Add(killed);
					t.Add(UpdateDeathTag(kill.DeathTags));
					t.Add(kill.CurrentPlayerState == PlayerState.Knocked);
					t.Add(TimeofDeath(kill.DeltaGameTimeSeconds));
					t.Add(kill.DeathTags);
					if (!(killer == "NPC" && killed == "NPC")) killFeed.Add(t);
				}	
			}
			
            /* Stats Processing */
			try {
				stats["kills"] = replay.Stats.Eliminations;
				stats["assists"] = replay.Stats.Assists;
				stats["accuracy"] = replay.Stats.Accuracy * 100;
				stats["dealt"] = replay.Stats.DamageToPlayers;
				stats["taken"] = replay.Stats.DamageTaken;
				stats["distance"] = replay.Stats.TotalTraveled;
			} catch (System.NullReferenceException) { // fails in creative modes at times? no idea why
				stats["kills"] = "N/A";
				stats["assists"] = "N/A";
				stats["accuracy"] = "N/A";
				stats["dealt"] = "N/A";
				stats["taken"] = "N/A";
				stats["distance"] = "N/A";
            }

			/* Placements Processing */
			List<string> pList = new List<string>();
			foreach (var p in replay.GameInformation.Players) {
				if (p.Teamindex > 2 && !StringContains(pList, p.Teamindex.ToString())) {
					pList.Add(p.Teamindex.ToString());
					JObject t = new JObject();
					t["team"] = p.Teamindex - 2;
					t["placement"] = p.Placement;
					t["members"] = p.IsBot ? "BOT" : p.EpicId.ToLower();
					t["kills"] = p.TeamKills;
					placements.Add(t);
                }
				else if (p.Teamindex > 2) { // adding a team member
					foreach (var t in placements) {
						if (t["team"].ToString() == (p.Teamindex - 2).ToString()) {
							t["members"] += "," + (p.IsBot ? "BOT" : p.EpicId.ToLower());
							if ((int)t["placement"] > p.Placement) t["placement"] = p.Placement; // best player of that team takes rank, otherwise this doesn't look right in things like squad fills where someone leaves early and teammates have different placements
							break;
                        }
                    }
                }
            }
			 
			playerList["owner"] = owner;
			playerList["team"] = team;
			playerList["file"] = file;
			playerList["session"] = session;
			playerList["time"] = timeStart;
			playerList["totalPlayers"] = totalPlayers;
			playerList["players"] = players;
			playerList["killfeed"] = killFeed;
			playerList["stats"] = stats;
			playerList["placements"] = placements;

			using (StreamWriter path = File.CreateText(@"playerList.json"))
			using (JsonTextWriter writer = new JsonTextWriter(path)) playerList.WriteTo(writer);
		}
	}
}
	
