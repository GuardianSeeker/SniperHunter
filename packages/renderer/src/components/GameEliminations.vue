<script lang="ts" setup>
import {ref} from 'vue';
import KillCard from './KillCard.vue';
import type {GameElimination} from '../../../preload/src/models/GameElimination';
import {GamePlayer} from '../../../preload/src/models/GamePlayer';
import {Player} from '../../../preload/src/models/Player';

function filterElimination(elim: GameElimination): boolean {
  let query = search.value.toLowerCase().trim();
  if (query.length <= 0) {
    return true;
  }
  else {
    const actionSearch = query.includes('knocked') ? 'knocked' : query.includes('killed') ? 'killed' : null;
    const killedOnly = (actionSearch != null && query.indexOf(actionSearch) == 0) ? true : false;
    let killed = props.players.filter(p => p.playerID == elim.killedID)[0] ?? new Player();
    let killer = killedOnly ? killed : props.players.filter(p => p.playerID == elim.killerID)[0] ?? new Player();
    let killedGamer = props.gamers.filter(g => g.playerID == elim.killedID)[0] ?? new GamePlayer();
    let killerGamer = killedOnly ? killedGamer : props.gamers.filter(g => g.playerID == elim.killerID)[0] ?? new GamePlayer();
    if (actionSearch && !(elim.knocked == (actionSearch == 'knocked'))) {
      return false;
    }
    if (query.includes('team')) {
      const teamNumber = parseInt(query.replace(/^\D+/g, ''));
      if (![killerGamer.team, killedGamer.team].includes(teamNumber)) {
        return false;
      }
    }
    else {
      query = query.replaceAll(actionSearch ?? '', '').trim();
      if (killer.username.toLowerCase().indexOf(query) == -1 &&
      killed.username.toLowerCase().indexOf(query) == -1) {
        return false;
      }
    }
    return true;
  }
}

const props = defineProps<{
  elims: GameElimination[],
  gamers: GamePlayer[],
  players: Player[],
}>();
const emit = defineEmits<{
  (event: 'search', query:string):void
}>();

const search = ref('');
defineExpose({
  search,
});
</script>

<template>
  <div>
    <input
      v-model="search"
      class="frame"
      placeholder="Search (filter by teams with 'team #')"
      @click="search = ''"
    />
    <div style="overflow: auto;">
      <span
        v-for="elim in elims"
        :key="elim.id"
      >
        <KillCard
          v-show="filterElimination(elim)"
          :elim="elim"
          :killer="players.filter(p => p.playerID == elim.killerID)[0]"
          :killed="players.filter(p => p.playerID == elim.killedID)[0]"
          :killer-player="gamers.filter(p => p.playerID == elim.killerID)[0]"
          :killed-player="gamers.filter(p => p.playerID == elim.killedID)[0]"
          @search="(query) => {search = query; emit('search', query)}"
        />
      </span>
    </div>
  </div>
</template>

<style scoped>
  input {
    width: 99%;
    height: 32px;
    appearance: none;
    outline: none;
    margin: 0 0 6px 0;
    padding: 0;
    text-align: center;
    background-color: var(--bg-alternate);
    color: var(--light-white);
  }
</style>
