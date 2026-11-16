import { Routes } from '@angular/router';
import { UploadPage } from './pages/upload/upload-page';
import { MatchPage } from './pages/match/match-page';
import { GamesPage } from './pages/games/games-page';
import { AboutPage } from './pages/about/about-page';
import { PlayersPage } from './pages/snipers/snipers-page';
import { PlayerPage } from './pages/player/player-page';
import { SqlPage } from './pages/sql/sql-page';
import { SettingsPage } from './pages/settings/settings-page';
import { localOnly } from './services/access.service';

/** Public page routes plus guarded local-only tools; unknown URLs return to the last match. */
export const routes: Routes = [
  { path: '', redirectTo: 'lastmatch', pathMatch: 'full' },
  { path: 'lastmatch', component: MatchPage },
  { path: 'games', component: GamesPage },
  { path: 'snipers', component: PlayersPage },
  { path: 'player/:id', component: PlayerPage },
  { path: 'sql', component: SqlPage, canActivate: [localOnly] },
  { path: 'settings', component: SettingsPage, canActivate: [localOnly] },
  { path: 'replay', component: UploadPage, canActivate: [localOnly] },
  { path: 'replay/:id', component: MatchPage },
  { path: 'about', component: AboutPage },
  { path: '**', redirectTo: 'lastmatch' },
];
