<script lang="ts" setup>
import {ref} from 'vue';

const props = defineProps<{
  title: string,
  open?: boolean
}>();
const isCollapsed = ref(true);
if (props.open != null && props.open == true) {
  isCollapsed.value = false;
}

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value;
};
</script>

<template>
  <div>
    <h2 class="collapsible" @click="toggleCollapse">{{ title }}</h2>
    <div class="collapsed" :class="{ uncollapsed: !isCollapsed }">
      <slot></slot>
    </div>
  </div>
</template>
