<script lang="ts" setup>
import { store } from './store';

import TitleBar from './components/TitleBar.vue';
import NavigationMenu from './components/NavigationMenu.vue';
import LoadingScreen from './components/LoadingScreen.vue';
import MatchHistory from './components/MatchHistory.vue';
import GameView from './components/GameView.vue';

import AboutPage from './pages/AboutPage.vue';
import LastMatch from './pages/LastMatch.vue';
import SettingsPage from './pages/SettingsPage.vue';
import SnipersHistory from './pages/SnipersHistory.vue';
import PlayerProfile from './pages/PlayerProfile.vue';
</script>

<template>
  <title-bar />
  <NavigationMenu class="frame" />
  <div id="content">
    <LastMatch v-if="store.target != null && store.target == 'last'" />
    <Suspense>
      <MatchHistory v-if="store.target != null && store.target == 'games'" />
      <template #fallback>
        <LoadingScreen />
      </template>
    </Suspense>
    <Suspense>
      <SnipersHistory v-if="store.target == 'snipers'" />
      <template #fallback>
        <LoadingScreen />
      </template>
    </Suspense>
    <SettingsPage v-if="store.target == 'settings'" />
    <AboutPage v-if="store.target == 'about'" />
    <Suspense>
      <GameView
        v-if="store.target == 'match'"
        :game-id="store.data"
      />
      <template #fallback>
        <LoadingScreen />
      </template>
    </Suspense>
    <Suspense>
      <PlayerProfile
        v-if="store.target == 'player'"
        :player-id="store.data"
      />
      <template #fallback>
        <LoadingScreen />
      </template>
    </Suspense>
  </div>
</template>
