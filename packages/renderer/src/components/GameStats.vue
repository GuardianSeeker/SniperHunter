<script lang="ts" setup>
import {convertTimestamp, convertDuration} from '../utilityFunctions';
import type {GameStat} from '../../../preload/src/models/GameStat';
import type {Player} from '../../../preload/src/models/Player';

const props = defineProps<{
  stats: GameStat
  players: Player[]
}>();
let creativeMode = props.stats.mode.toLowerCase().includes('creative');
</script>

<template>
  <table>
    <tr style="text-align: center;"><td :colspan="2">Stats</td></tr>
    <tr>
      <td>Session ID</td>
      <td>{{ stats.gameID }}</td>
    </tr>
    <tr>
      <td>Timestamp</td>
      <td>{{ convertTimestamp(stats.timestamp) }}</td>
    </tr>
    <tr>
      <td>File</td>
      <td>{{ stats.replayName }}</td>
    </tr>
    <tr>
      <td>Mode</td>
      <td>{{ stats.mode }}</td>
    </tr>
    <tr>
      <td>Real Players</td>
      <td>{{ stats.players }}/{{ stats.players + stats.bots }}</td>
    </tr>
    <tr>
      <td>Duration</td>
      <td>{{ convertDuration(stats.duration) }}</td>
    </tr>
    <tr v-if="!creativeMode">
      <td>Placement</td>
      <td>{{ stats.placement }}</td>
    </tr>
    <tr v-if="!creativeMode">
      <td>Kills</td>
      <td>{{ stats.kills }}</td>
    </tr>
    <tr v-if="!creativeMode">
      <td>Assists</td>
      <td>{{ stats.assists }}</td>
    </tr>
    <tr v-if="!creativeMode">
      <td>Accuracy</td>
      <td>{{ Math.round(stats.accuracy * 100 * 100) / 100 }}%</td>
    </tr>
    <tr v-if="!creativeMode">
      <td>Damage Dealt</td>
      <td>{{ stats.damageDealt }}</td>
    </tr>
    <tr v-if="!creativeMode">
      <td>Damage Taken</td>
      <td>{{ stats.damageTaken }}</td>
    </tr>
    <tr v-if="!creativeMode">
      <td>Distance Travelled</td>
      <td>{{ stats.distanceTravelled / 100 }} m</td>
    </tr>
  </table>
</template>

<style scoped>
table {
  width: min-content;
  height: 100%;
  overflow: auto;
  font-size: 75%;
  padding-right: 2px;
  margin-bottom: -6px;
}

td {
  padding: 4px;
  border: 1px solid var(--red-red);
}

tr td:nth-child(even) {
  text-align: center;
  font-size: 90%;
}

tr td:nth-child(odd) {
  -khtml-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}
</style>
