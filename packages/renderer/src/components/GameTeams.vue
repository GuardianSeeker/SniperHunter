<script lang="ts" setup>
import {ref} from 'vue';
import {store} from '../store';
import {getSkin, getTeamColor} from '../utilityFunctions';
import type {GameElimination} from '../../../preload/src/models/GameElimination';
import type {GamePlayer} from '../../../preload/src/models/GamePlayer';
import type {Player} from '../../../preload/src/models/Player';

const emit = defineEmits<{
  (event: 'search', query:string):void
}>();
const props = defineProps<{
  elims: GameElimination[],
  gamers: GamePlayer[],
  players: Player[],
}>();

function emitSearch(query:string) {
  if (!dragBlock.value) {
    emit('search', query);
  }
}

function getUsername(gamer:GamePlayer) {
  if (gamer == null) {
    return '';
  }
  return props.players.filter(p => p.playerID == gamer.playerID)[0].username;
}

function getKills(gamer:GamePlayer) {
  if (gamer == null) {
    return '';
  }
  return `${gamer.kills} kills`;
}

function filterTeams(value:string) {
  sorting.value = value;
  switch (value) {
    case 'Team':
      teams.sort((a, b) => { return a[0].team - b[0].team; });
      break;
    case 'Placement':
      teams.sort((a, b) => { return Math.min(...a.map(m => m.placement)) - Math.min(...b.map(m => m.placement)); });
      break;
    case 'Kills':
      teams.sort((a, b) => { return a.reduce((a, b) => a + b.kills, 0) - b.reduce((a, b) => a + b.kills, 0); }).reverse();
      break;
  }
}

function dragTable(event:MouseEvent) {
  function dragging(e:MouseEvent) {
    dragBlock.value = true;
    const dx = e.clientX - pos.x;
    const dy = e.clientY - pos.y;
    tableDiv.scrollTop = pos.top - dy;
    tableDiv.scrollLeft = pos.left - dx;
  }
  function released() {
    tableDiv.removeEventListener('mousemove', dragging);
    tableDiv.removeEventListener('mouseup', released);
    setTimeout(() => {
      dragBlock.value = false;
    }, 50);
  }
  const tableDiv = document.getElementById('teamElims')?.parentElement as HTMLDivElement;
  let pos = {
      top: tableDiv.scrollTop,
      left: tableDiv.scrollLeft,
      x: event.clientX,
      y: event.clientY,
  };
  tableDiv.addEventListener('mousemove', dragging);
  tableDiv.addEventListener('mouseup', released);
  tableDiv.addEventListener('mouseleave', released);
}

function focusPlayer(username:string) {
  let users = document.getElementsByClassName('username');
  for (let x = 0; x < users.length; x++) {
    const user = users[x] as HTMLTableCellElement;
    if (user.innerText == username) {
      const tableDiv = document.getElementById('teamElims')?.parentElement as HTMLDivElement;
      if (tableDiv.parentElement != null && tableDiv.scrollHeight > tableDiv.parentElement.scrollHeight) {
        user.parentElement?.scrollIntoView();
        tableDiv.scrollTop =  tableDiv.scrollTop - 30;
      }
    }
  }
}

const sorting = ref('Placement');
let teams:GamePlayer[][] = [];
let currentTeam = -1;
const dragBlock = ref(false);
const hasWinners = props.gamers.filter(g => g.placement == 1).length > 0;
props.gamers.filter(g => g.team != 0).forEach((gamer) => {
  if (hasWinners == true && gamer.placement == 0) {
    gamer.placement = 999;
  }
  if (gamer.team != currentTeam) {
    teams.push([gamer]);
    currentTeam = gamer.team;
  }
  else {
    teams.at(-1)?.push(gamer);
  }
});
const teamSize = Math.max(...teams.map(t => t.length));
filterTeams(sorting.value);

defineExpose({
  focusPlayer,
});
</script>

<template>
  <div>
    <table
      id="teamElims"
      :class="{ dragCursor: dragBlock }"
      style="text-align: center"
      class="standardTable noselect"
      @mousedown="dragTable"
    >
      <tr class="noselect">
        <th
          :class="{ active: sorting == 'Team' }"
          style="cursor: pointer;"
          @click="filterTeams('Team');"
        >
          Team
        </th>
        <th :colspan="teamSize">
          Members
        </th>
        <th
          :class="{ active: sorting == 'Placement' }"
          style="cursor: pointer;"
          @click="filterTeams('Placement');"
        >
          Placement
        </th>
        <th
          :class="{ active: sorting == 'Kills' }"
          style="cursor: pointer;"
          @click="filterTeams('Kills');"
        >
          Kills
        </th>
      </tr>
      <tr
        v-for="team in teams"
        :key="team[0].team"
      >
        <td
          :class="{ dragCursor: dragBlock }"
          :style="{'cursor': 'pointer',
                   'font-size': '200%',
                   '-webkit-text-stroke': '1px black',
                   'background-color': `${getTeamColor(team[0].team)}`}"
          @click="emitSearch(`team ${team[0].team}`)"
        >
          {{ team[0].team }}
        </td>
        <td
          v-for="index in teamSize"
          :key="index"
          :class="{ dragCursor: dragBlock }"
          style="cursor: pointer;"
          @click="emitSearch(getUsername(team[index - 1]))"
          @dblclick="store.setTarget('player', team[index - 1].playerID)"
        >
          <img
            v-if="team[index-1] != null"
            :src="`../../assets/skins/${getSkin(players.filter(p => p.playerID == team[index - 1].playerID)[0])}.png`"
            :ondragstart="() => { return false; }"
            width="48"
          />
          <br />
          <span class="username">{{ getUsername(team[index - 1]) }}</span>
          <br />
          {{ getKills(team[index - 1]) }}
        </td>
        <td>{{ Math.min(...team.map(m => m.placement)) }}</td>
        <td>{{ team.reduce((a, b) => a + b.kills, 0) }}</td>
      </tr>
    </table>
  </div>
</template>

<style scoped>
.dragCursor {
  cursor: grabbing !important;
}
</style>
