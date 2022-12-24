<script lang="ts" setup>
import {ref} from 'vue';
import {store} from '../store';
import {db, addReplay} from '#preload';
import {convertTimestamp} from '../utilityFunctions';
import {GameStat} from '../../../preload/src/models/GameStat';
import LoadingScreen from './LoadingScreen.vue';

function keyStamp(timestamp:Date) {
  return new Date(timestamp).getTime();
}

async function loadGames(page: number, forceScroll = true) {
  async function fetchResults() {
    let result:GameStat[];
    if (props.playerId != null) {
      result = await db.getGamerHistory(currentPage.value, props.playerId);
    }
    else {
      result = await db.getMatchHistory(currentPage.value);
    }
    return result;
  }
  if (page < 1) {
    page = 1;
  }
  currentPage.value = page;
  let result = await fetchResults();
  if (result.length <= 0) {
    --currentPage.value;
    result = await fetchResults();
  }
  games.value = result;
  if (forceScroll) {
    setTimeout(() => {
      let content = document.getElementById('content');
      if (content?.scrollHeight != null) {
        content.scrollTop = content?.scrollHeight;
      }
    }, 1);
  }
}

async function deleteGame(gameID:string) {
  loading.value = true;
  if (!(await db.deleteMatch(gameID))) {
    alert('Failed to delete the selected game properly.');
  }
  else {
    await loadGames(currentPage.value, false);
  }
  loading.value = false;
}

async function chooseReplays() {
  loading.value = true;
  const res = await addReplay();
  loading.value = false;
  if (res != null) {
    store.setTarget(res);
  }
  else {
    const temp = store.previous;
    store.setTarget(temp);
    setTimeout(() => {
      store.setTarget(store.previous);
    }, 50);
  }
}

const props = defineProps<{
  playerId?:string
}>();

const loading = ref(false);
const games = ref([new GameStat()]);
const currentPage = ref(1);
loadGames(currentPage.value, false);
</script>

<template>
  <div>
    <LoadingScreen v-if="loading" />
    <table class="standardTable">
      <tr class="noselect">
        <th>Game ID</th>
        <th>Time</th>
        <th>Mode</th>
        <th>Placement</th>
        <th>Delete</th>
      </tr>
      <tr
        v-for="game in games"
        :key="keyStamp(game.timestamp)"
      >
        <td
          class="clickableColumn"
          @click="store.setTarget('match', game.gameID)"
        >
          {{ game.gameID }}
        </td>
        <td>{{ convertTimestamp(game.timestamp) }}</td>
        <td>{{ game.mode }}</td>
        <td>{{ game.placement }}</td>
        <td
          class="clickableColumn noselect"
          @click="deleteGame(game.gameID)"
        >
          🗑️
        </td>
      </tr>
    </table>
    <div
      class="noselect"
      style="padding-top: 4px; margin-bottom: 50px;"
    >
      <button
        v-show="(currentPage > 1)"
        style="float: left; margin-left: 3px;"
        @click="loadGames(--currentPage)"
      >
        Previous
      </button>
      <button
        v-if="playerId == null"
        style="position: absolute; left: 37.5%;"
        @click="chooseReplays"
      >
        Add Game(s)
      </button>
      <button
        v-show="(games.length >= 25)"
        style="float: right; margin-right: 3px;"
        @click="loadGames(++currentPage)"
      >
        Next
      </button>
    </div>
  </div>
</template>

<style scoped>
.clickableColumn {
  cursor: pointer;
}

.clickableColumn:hover {
  color: var(--red-red);
}

table {
  text-align: center;
  font-size: 100%;
}

th {
  transform: translateY(-4px);
}

button {
  width: 25%;
  height: 48px;
  border: 1px solid var(--red-red);
}

button:active {
  background-color: var(--red-red);
}
</style>
