export const GunType = {
  0: "Storm",
  1: "Fall",
  2: "Pistol",
  3: "Shotgun",
  4: "Rifle",
  5: "SMG",
  6: "Sniper",
  7: "NoScope",
  8: "Pickaxe",
  10: "Grenade",
  11: "C4",
  12: "GrenadeLauncher",
  13: "Explosives",
  14: "Minigun",
  15: "Bow",
  16: "Trap",
  17: "FinallyEliminated",
  23: "Vehicle",
  30: "Stink",
  31: "Water",
  32: "Turret",
  48: "Unknown"
}


export interface ReplayData {
  Eliminations?: (EliminationsEntity)[] | null;
  Stats?: Stats;
  TeamStats?: TeamStats;
  GameData: GameData;
  TeamData?: (TeamDataEntity)[] | null;
  PlayerData?: (PlayerDataEntity)[] | null;
  KillFeed?: (KillFeedEntity)[] | null;
  MapData: MapData;
  Info: Info;
  Header: Header;
}
export interface EliminationsEntity {
  EliminatedInfo: EliminatedInfoOrEliminatorInfo;
  EliminatorInfo: EliminatedInfoOrEliminatorInfo;
  Eliminated: string;
  Eliminator: string;
  GunType: number;
  Time: string;
  Knocked: boolean;
  IsSelfElimination: boolean;
  IsValidLocation: boolean;
  Distance: number;
  Info: Info1;
}
export interface EliminatedInfoOrEliminatorInfo {
  Id: string;
  PlayerType: number;
  Rotation: Rotation;
  Location: LocationOrScaleOrDeathLocation;
  Scale: LocationOrScaleOrDeathLocation;
  IsBot: boolean;
}
export interface Rotation {
  X: number;
  Y: number;
  Z: number;
  W: number;
}
export interface LocationOrScaleOrDeathLocation {
  X: number;
  Y: number;
  Z: number;
  ScaleFactor: number;
  Bits: number;
}
export interface Info1 {
  Id: string;
  Group: string;
  Metadata: string;
  StartTime: number;
  EndTime: number;
  SizeInBytes: number;
}
export interface Stats {
  Unknown: number;
  Eliminations: number;
  Accuracy: number;
  Assists: number;
  WeaponDamage: number;
  OtherDamage: number;
  DamageToPlayers: number;
  Revives: number;
  DamageTaken: number;
  DamageToStructures: number;
  MaterialsGathered: number;
  MaterialsUsed: number;
  TotalTraveled: number;
  Info: Info1;
}
export interface TeamStats {
  Unknown: number;
  Position: number;
  TotalPlayers: number;
  Info: Info1;
}
export interface GameData {
  GameSessionId?: string;
  UtcTimeStartedMatch: string;
  MatchEndTime?: null;
  MapInfo?: null;
  CurrentPlaylist: string;
  AdditionalPlaylistLevels?: null;
  ActiveGameplayModifiers?: (string)[] | null;
  RecorderId: number;
  MaxPlayers: number;
  TotalTeams?: null;
  TotalBots?: null;
  TeamSize: number;
  TotalPlayerStructures: number;
  IsTournamentRound: boolean;
  TournamentRound?: null;
  IsLargeTeamGame?: null;
  AircraftStartTime?: null;
  SafeZonesStartTime?: null;
  WinningTeam?: null;
  WinningPlayerIds?: null;
}
export interface TeamDataEntity {
  TeamIndex: number;
  PlayerIds?: (number)[] | null;
  PlayerNames?: (string)[] | null;
  PartyOwnerId?: number | null;
  Placement?: number | null;
  TeamKills?: number | null;
}
export interface PlayerDataEntity {
  Id: number;
  PlayerId?: string | null;
  EpicId?: string | null;
  PlatformUniqueNetId?: string | null;
  BotId?: string | null;
  IsBot: boolean;
  PlayerName: string;
  PlayerNameCustomOverride?: string | null;
  StreamerModeName?: null;
  Platform?: string | null;
  Level?: number | null;
  SeasonLevelUIDisplay?: number | null;
  InventoryId?: null;
  PlayerNumber?: number | null;
  TeamIndex: number;
  IsPartyLeader: boolean;
  IsReplayOwner: boolean;
  IsGameSessionOwner?: null;
  HasFinishedLoading?: boolean | null;
  HasStartedPlaying?: boolean | null;
  HasThankedBusDriver?: boolean | null;
  IsUsingStreamerMode?: null;
  IsUsingAnonymousMode?: boolean | null;
  Disconnected?: boolean | null;
  RebootCounter?: null;
  Placement?: number | null;
  Kills?: number | null;
  TeamKills?: number | null;
  DeathCause?: number | null;
  DeathCircumstance?: null;
  DeathTags?: (string)[] | null;
  DeathLocation?: LocationOrScaleOrDeathLocation1 | null;
  DeathTime?: number | null;
  DeathTimeDouble?: number | null;
  Cosmetics: Cosmetics;
  CurrentWeapon?: number | null;
  Locations?: (null)[] | null;
}
export interface LocationOrScaleOrDeathLocation1 {
  X: number;
  Y: number;
  Z: number;
  ScaleFactor: number;
  Bits: number;
}
export interface Cosmetics {
  CharacterGender?: number | null;
  CharacterBodyType?: number | null;
  Parts: string;
  VariantRequiredCharacterParts?: (string)[] | null;
  HeroType?: string | null;
  BannerIconId?: string | null;
  BannerColorId?: string | null;
  ItemWraps?: (string | null)[] | null;
  SkyDiveContrail?: string | null;
  Glider?: string | null;
  Pickaxe?: string | null;
  IsDefaultCharacter?: null;
  Character?: string | null;
  Backpack?: string | null;
  LoadingScreen?: string | null;
  Dances?: (string)[] | null;
  MusicPack?: string | null;
  PetSkin?: null;
}
export interface KillFeedEntity {
  PlayerId: number;
  PlayerName: string;
  PlayerIsBot: boolean;
  FinisherOrDowner?: number | null;
  FinisherOrDownerName?: string | null;
  FinisherOrDownerIsBot: boolean;
  ReplicatedWorldTimeSeconds: number;
  ReplicatedWorldTimeSecondsDouble: number;
  Distance?: number | null;
  DeathCause?: number | null;
  DeathLocation: LocationOrScaleOrDeathLocation;
  DeathCircumstance?: null;
  DeathTags?: (string)[] | null;
  IsDowned: boolean;
  IsRevived: boolean;
}
export interface MapData {
  BattleBusFlightPaths?: null;
  SafeZones?: (null)[] | null;
  Llamas?: (null)[] | null;
  SupplyDrops?: (null)[] | null;
  RebootVans?: (null)[] | null;
  WorldGridStart?: null;
  WorldGridEnd?: null;
  WorldGridSpacing?: null;
  GridCountX?: null;
  GridCountY?: null;
  WorldGridTotalSize?: null;
}
export interface Info {
  LengthInMs: number;
  NetworkVersion: number;
  Changelist: number;
  FriendlyName: string;
  Timestamp: string;
  TotalDataSizeInBytes: number;
  IsLive: boolean;
  IsCompressed: boolean;
  IsEncrypted: boolean;
  EncryptionKey: EncryptionKey;
  FileVersion: number;
}
export interface EncryptionKey {
  Length: number;
  IsEmpty: boolean;
}
export interface Header {
  NetworkVersion: number;
  NetworkChecksum: number;
  EngineNetworkVersion: number;
  GameNetworkProtocolVersion: number;
  Guid: string;
  Major: number;
  Minor: number;
  Patch: number;
  Changelist: number;
  Branch: string;
  UE4Version: number;
  UE5Version: number;
  PackageVersionLicenseeUE: number;
  LevelNamesAndTimes?: (LevelNamesAndTimesEntity)[] | null;
  Flags: number;
  GameSpecificData?: (string)[] | null;
  Platform: string;
  BuildTargetType: number;
}
export interface LevelNamesAndTimesEntity {
  Item1: string;
  Item2: number;
}