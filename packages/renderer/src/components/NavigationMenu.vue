<script lang="ts" setup>
import {store} from '../store';
</script>

<template>
  <nav>
    <button
      :class="{ active: store.target == 'last' }"
      @click="store.setTarget('last');"
    >
      Last Match
    </button>
    <button
      :class="{ active: store.target == 'games' }"
      @click="store.setTarget('games');"
    >
      Games
    </button>
    <button
      :class="{ active: store.target == 'snipers' }"
      @click="store.setTarget('snipers');"
    >
      Snipers List
    </button>
    <button
      v-if="false"
      :class="{ active: store.target == 'settings' }"
      @click="store.setTarget('settings');"
    >
      Settings
    </button>
    <button
      :class="{ active: store.target == 'about' }"
      @click="store.setTarget('about');"
    >
      About
    </button>
  </nav>
</template>

