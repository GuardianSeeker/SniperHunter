<script lang="ts" setup>
import {store} from '../store';
import {copyField, getSkin, getTeamColor} from '../utilityFunctions';
import type {Player} from '../../../preload/src/models/Player';
import type { GamePlayer } from '../../../preload/src/models/GamePlayer';

const props = defineProps<{
  player: Player,
  gamer?: GamePlayer
}>();
const cardColor = props.gamer == null ? {} : { 'background-image': `linear-gradient(to right, transparent 33%, ${getTeamColor(props.gamer.team)} 100%) ` };
</script>

<template>
  <div
    class="playerCard frame"
    :style="cardColor"
  >
    <img
      class="noselect"
      title="View Profile"
      :src="`../../assets/skins/${getSkin(player)}.png`"
      @click="store.setTarget('player', player.playerID)"
    >
    <span
      class="noselect copyable"
      @click="copyField($event, 'Username', player.username)"
    >Username:</span> {{ player.username }}<br />
    <span
      class="noselect copyable"
      @click="copyField($event, 'Player ID', player.playerID)"
    >ID:</span> {{ player.playerID }}<br />
    <span class="noselect">Platform:</span> {{ player.isBot == true ? 'EPIC AI' : player.platform }}<br />
    <span class="noselect">Games:</span> {{ player.snipes }}<br />
  </div>
</template>
