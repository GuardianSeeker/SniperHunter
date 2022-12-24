<script lang="ts" setup>
import {ref} from 'vue';
import {db} from '#preload';
import PlayerCard from '../components/PlayerCard.vue';
import type {Player} from '../../../preload/src/models/Player';

function calcLimit() {
  return Math.floor((content.clientHeight - contentOffset) / 86) * 3;
}

function filterPlayers() {
  const query = search.value.toLowerCase();
  limit = calcLimit();
  let tempFilter:Player[] = [];
  if (query.length > 0) {
    tempFilter = players.filter(p => p.playerID.toLowerCase().startsWith(query) || p.username.toLowerCase().includes(query));
    searchCount.value = `${limit > tempFilter.length ? tempFilter.length : limit} / ${tempFilter.length}`;
  }
  else {
    tempFilter = players.filter(p => p.isBot == false && p.snipes > 2);
    searchCount.value = `${tempFilter.slice(0, limit).length} / ${players.length} players`;
  }
  filteredPlayers.value = tempFilter.slice(0, limit);
}
const players = await db.getSnipers();
const content = document.getElementById('content') as HTMLDivElement;
const contentOffset = 34 + 24;
let limit = calcLimit();
const filteredPlayers = ref(players.filter(p => p.isBot == false && p.snipes > 2).slice(0, limit));
const searchCount = ref(`${filteredPlayers.value.length} / ${players.length} players`);
const search = ref('');
</script>

<template>
  <div>
    <input
      v-model="search"
      class="frame"
      placeholder="Search"
      @keyup="filterPlayers"
    />
    <div id="sniperHistory">
      <PlayerCard
        v-for="player in filteredPlayers"
        :key="player.playerID"
        :player="player"
      />
    </div>
    <div class="sniperStats">
      <span>Platform Metrics → &nbsp;</span>
      <span>PC: {{ players.filter(p => p.platform == 'WIN').length }}</span>
      <span>&nbsp;| Playstation: {{ players.filter(p => ['PSN', 'PS5'].includes(p.platform)).length }}</span>
      <span>&nbsp;| Xbox: {{ players.filter(p => ['XBL', 'XSX'].includes(p.platform)).length }}</span>
      <span>&nbsp;| Switch: {{ players.filter(p => p.platform == 'SWT').length }}</span>
      <span>&nbsp;| Android/iPhone: {{ players.filter(p => p.isBot == false && ['AND', 'IOS'].includes(p.platform)).length }}</span>
      <span style="float: right;">{{ searchCount }}</span>
    </div>
  </div>
</template>

<style scoped>
input {
  width: 100%;
}
.sniperStats {
  height: 0px;
  position: relative;
  top: 0.2em;
}
.sniperStats span {
  float: left;
}
</style>
