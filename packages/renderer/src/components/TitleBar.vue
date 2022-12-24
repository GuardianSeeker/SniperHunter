<script lang="ts" setup>
import {closeProgram, minimizeProgram} from '#preload';
</script>

<template>
  <div
    id="titleBar"
  >
    <span
      style="
        font-family: Arial, Helvetica, sans-serif;
        position: fixed;
        top: 2px; left: 87px; right: 87px;
        text-align: center;
      "
      class="noselect"
    >
      Sniper Hunter by Guardian Seeker
    </span>
    <span
      class="noselect titleButton"
      @click="minimizeProgram()"
    >-</span>
    <span
      class="noselect titleButton"
      @click="closeProgram()"
    >
      <span style="position: relative; bottom: 2px;">x</span>
    </span>
  </div>
</template>
