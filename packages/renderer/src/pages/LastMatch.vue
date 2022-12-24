<script lang="ts" setup>
import GameView from '../components/GameView.vue';
import LoadingScreen from '../components/LoadingScreen.vue';
</script>

<template>
  <div>
    <Suspense>
      <GameView />
      <template #fallback>
        <LoadingScreen />
      </template>
    </Suspense>
  </div>
</template>

