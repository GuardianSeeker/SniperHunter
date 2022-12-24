<script lang="ts" setup>
import {ref} from 'vue';
import {db} from '#preload';
import {store} from '../store';
import GameEliminations from './GameEliminations.vue';
import GameTeams from './GameTeams.vue';
import GameStats from './GameStats.vue';
import PlayerCard from './PlayerCard.vue';

  const props = defineProps<{
  gameId?: string
}>();

const validGameID = ref(props.gameId ?? await db.getLastGameID());
if (validGameID.value == null) {
  store.setTarget('about');
}
const stats = await db.getGameStats(validGameID.value);
const elims = await db.getEliminations(validGameID.value);
const gamers = await db.getGamers(validGameID.value);
const players = await db.getGamerPlayers(gamers);
const snipers = ref(players
  .filter(p =>
    p.snipes >= 2 &&
    p.isBot == false &&
    p.playerID != stats.owner)
  .sort((a, b) => {
    return a.snipes - b.snipes;
  })
  .reverse());
const search = ref({search: ''});
const focus = ref(null);
</script>

<template>
  <div>
    <div
      v-if="validGameID != null"
      id="gamePanels"
    >
      <div style="min-width: fit-content; width: auto;">
        <GameStats
          :stats="stats"
          :players="players"
        />
      </div>
      <GameEliminations
        ref="search"
        :elims="elims"
        :gamers="gamers"
        :players="players"
        @search="(query) => {focus.focusPlayer(query)}"
      />
      <GameTeams
        ref="focus"
        :elims="elims"
        :gamers="gamers"
        :players="players"
        @search="(query) => {search.search = query}"
      />
    </div>
    <span v-if="snipers.length > 0">
      <hr />
      <h2 style="padding-bottom: 12px;">Snipers</h2>
      <div id="sniperHistory">
        <PlayerCard
          v-for="player in snipers"
          :key="player.playerID"
          :player="player"
          :gamer="gamers.filter(g => g.playerID == player.playerID)[0]"
        />
      </div>
    </span>
  </div>
</template>
