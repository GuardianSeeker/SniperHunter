<script lang="ts" setup>
import {ref} from 'vue';
import {store} from '../store';
import {db, openUrl} from '#preload';
import {copyField, getSkin} from '../utilityFunctions';
import MatchHistory from '../components/MatchHistory.vue';

const props = defineProps<{
  playerId: string,
}>();

function closeProfile(event?:KeyboardEvent) {
  if (event != null && event.key == 'Escape') {
    document.removeEventListener('keyup', closeProfile);
    if (document.getElementById('playerProfile') != null) {
      store.setTarget(store.previous, store.outDatad);
    }
  }
  else if (event == null) {
    store.setTarget(store.previous, store.outDatad);
  }
}

let player = ref(await db.getPlayer(props.playerId));
document.addEventListener('keyup', closeProfile);
</script>

<template>
  <div id="playerProfile">
    <div
      style="grid-area: 1 / 1 / 4 / 1; text-align: center;"
    >
      <img
        class="noselect"
        width="75"
        :src="`../../assets/skins/${getSkin(player)}.png`"
      >
      <br v-if="player.skin != null" />
      <span v-show="player.skin != null">Skin: {{ player.skin }}</span>
      <br /><br />
      <span
        id="statsLink"
        class="frame"
        @click="openUrl(`https://fortnitetracker.com/profile/all/${player.playerID}`)"
      >Open Fortnite Tracker Profile</span>
    </div>
    <div
      style="grid-area: 1 / 2 / 1 / 2"
    >
      <span
        class="copyable"
        @click="copyField($event, 'Username', player.username)"
      >Username:</span> {{ player.username }}
    </div>
    <div
      style="grid-area: 2 / 2 / 2 / 2"
    >
      <span
        class="copyable"
        @click="copyField($event, 'Epic ID', player.playerID)"
      >Epic ID:</span> {{ player.playerID }}
    </div>
    <div
      style="grid-area: 3 / 2 / 3 / 2"
    >
      Platform: {{ player.platform ?? 'EPIC AI' }}
    </div>
    <div
      style="grid-area: 4 / 2 / 4 / 2"
    >
      Games: {{ player.snipes }}
    </div>
    <div
      style="grid-area: 5 / 1 / 5 / 3"
    >
      <MatchHistory
        :player-id="playerId"
      />
    </div>
    <div
      id="closeProfile"
      class="noselect frame"
      @click="closeProfile()"
    >
      X
    </div>
  </div>
</template>

<style scoped>
table th {
  transform: translateY(-8px);
}
</style>
