/** Stored match statistics: duration in milliseconds, accuracy as a fraction and travel distance in centimetres. */
export interface GameStat {
  gameID: string;
  owner: string;
  timestamp: string;
  replayName: string;
  mode: string;
  bots: number;
  players: number;
  duration: number;
  placement: number;
  kills: number;
  assists: number;
  accuracy: number;
  damageDealt: number;
  damageTaken: number;
  distanceTravelled: number;
}

/** Per-match platform population shown beside player statistics. */
export interface PlatformCount {
  platform: string;
  players: number;
}

/** Feed event with millisecond time and resolved player labels/icons; knocked distinguishes knocks from eliminations. */
export interface Elimination {
  id: number;
  time: number;
  killerID: string;
  killedID: string;
  knocked: number;
  weapon: string;
  killerName: string;
  killedName: string;
  killerSkin: string | null;
  killedSkin: string | null;
  killerPlatform: string | null;
  killedPlatform: string | null;
  killerBot: number;
  killedBot: number;
}

/** Match membership with database kills, derived elimination deaths and historical games count. */
export interface MatchMember {
  playerID: string;
  username: string;
  platform: string | null;
  skin: string | null;
  isBot: number;
  team: number;
  placement: number;
  kills: number;
  deaths: number;
  games: number;
}

/** Displayed team number, aggregate stats and its member cards. */
export interface MatchTeam {
  team: number;
  placement: number;
  kills: number;
  deaths: number;
  members: MatchMember[];
}

/** Combined replay-page payload returned by the match-detail endpoint. */
export interface MatchDetails {
  match: GameStat | null;
  platforms: PlatformCount[];
  eliminations: Elimination[];
  teams: MatchTeam[];
  snipers: MatchMember[];
}

/** Compact match row used in recent-game lists and replay navigation. */
export type RecentGame = Pick<
  GameStat,
  'gameID' | 'timestamp' | 'replayName' | 'mode' | 'placement'
>;
