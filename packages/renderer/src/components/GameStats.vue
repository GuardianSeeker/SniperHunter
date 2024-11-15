<script lang="ts" setup>
import {convertTimestamp, convertDuration} from '../utilityFunctions';
import type {GameStat} from '../../../preload/src/models/GameStats';
import type {Player} from '../../../preload/src/models/Player';

const props = defineProps<{
  stats: GameStat
  players: Player[]
}>();

function groupPlayersByPlatform() {
  const groupedPlayers: { [platform: string]: number } = {};
  const sortedPlayers = props.players.sort((a, b) => {
    if (a.platform === null || a.platform === "NULL") return -1;
    if (b.platform === null || b.platform === "NULL") return 1;
    return a.platform.localeCompare(b.platform, "en", { sensitivity: "base" });
  });

  sortedPlayers.forEach((player) => {
    const platform = player.platform;
    if (platform == null || platform == "NULL") return;
    if (!groupedPlayers[platform]) {
      groupedPlayers[platform] = 0;
    }
    groupedPlayers[platform]++;
  });
  
  const formattedString = Object.entries(groupedPlayers)
  .map(([platform, count]) => `${platform}: ${count} players`)
  .join("<br/>");

  return formattedString;
}

let creativeMode = props.stats.mode.toLowerCase().includes('creative');
</script>

<template>
  <div class="stats-container">
  <div class="section">
    <h3>Match Information</h3>
    <p><strong>Session ID:</strong> {{ stats.gameID }}</p>
    <p><strong>Timestamp:</strong> {{ convertTimestamp(stats.timestamp) }}</p>
    <p><strong>File:</strong> {{ stats.replayName }}</p>
    <p><strong>Mode:</strong> {{ stats.mode }}</p>
    <p><strong>Real Players:</strong> {{ stats.players }}/{{ stats.players + stats.bots }}</p>
    <p><strong>Duration:</strong> {{ convertDuration(stats.duration) }}</p>
  </div>

  <div class="section">
    <h3 v-if="!creativeMode">Player Statistics</h3>
    <div v-if="!creativeMode" class="player-stats">
      <p><strong>Placement:</strong> {{ stats.placement }}</p>
      <p><strong>Kills:</strong> {{ stats.kills }}</p>
      <p><strong>Assists:</strong> {{ stats.assists }}</p>
      <p><strong>Accuracy:</strong> {{ Math.round(stats.accuracy * 100 * 100) / 100 }}%</p>
      <p><strong>Damage Dealt:</strong> {{ stats.damageDealt }}</p>
      <p><strong>Damage Taken:</strong> {{ stats.damageTaken }}</p>
      <p><strong>Distance Travelled:</strong> {{ stats.distanceTravelled / 100 }} m</p>
    </div>

    <div class="platform-distribution">
      <h3>Platform Distribution</h3>
      <p><span v-html="groupPlayersByPlatform()"></span></p>
    </div>
  </div>
</div>
</template>

<style scoped>
.stats-container {
  display: flex;
  justify-content: space-between;
}

.section {
  width: 50%;
  padding: 10px;
  text-align: center;
}

.section p {
  padding: 3px 0;
  margin: 0;
}

.section h3 {
  margin: 0;
  padding: 0;
  text-align: center;
  border-bottom: 1px solid var(--red-red)
}
</style>
