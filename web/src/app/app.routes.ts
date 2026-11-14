import { Routes } from '@angular/router';
import { UploadPage } from './upload-page';
import { MatchPage } from './match-page';
import { GamesPage } from './games-page';
import { AboutPage } from './about-page';
import { PlayersPage } from './snipers-page';
import { PlayerPage } from './player-page';
import { SqlPage } from './sql-page';
import { SettingsPage } from './settings-page';
import { localOnly } from './access.service';

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
