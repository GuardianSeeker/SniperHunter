  <script lang="ts" setup>
import {ref} from 'vue';
import {convertKillTime, getSkin, getTeamColor} from '../utilityFunctions';
import type {GameElimination} from '../../../preload/src/models/GameElimination';
import type {GamePlayer} from '../../../preload/src/models/GamePlayer';
import {Player} from '../../../preload/src/models/Player';

const props = defineProps<{
  elim: GameElimination,
  killer: Player,
  killed: Player,
  killerPlayer: GamePlayer,
  killedPlayer: GamePlayer,
}>();
const emit = defineEmits<{
  (event: 'search', query:string):void
}>();

const botPlayer = ref(new Player());
const attack = ref(`${props.elim.knocked ? 'knocked' : 'killed'} with ${props.elim.weapon}`);
const validKiller = ref(props.killer ?? botPlayer);
const validKilled = ref(props.killed ?? botPlayer);
</script>

<template>
  <div
    class="killcard"
  >
    <div
      class="killer playerThumb"
      @click="emit('search', validKiller.username)"
    >
      <img
        :style="{ 'border': `4px solid ${getTeamColor(killerPlayer ? killerPlayer.team : 0)}` }"
        :src="`../../assets/skins/${getSkin(validKiller)}.png`"
      />
      <br />
      {{ validKiller.username }}
    </div>
    <div
      class="killed playerThumb"
      @click="emit('search', validKilled.username)"
    >
      <img
        :style="{ 'border': `4px solid ${getTeamColor(killedPlayer ? killedPlayer.team : 0)}` }"
        :src="`../../assets/skins/${getSkin(validKilled)}.png`"
      />
      <br />
      {{ validKilled.username }}
    </div>
    <div
      class="attack noselect"
    >
      {{ attack }}
    </div>
    <div class="elimTime noselect">{{ convertKillTime(elim.time) }}</div>
  </div>
</template>
