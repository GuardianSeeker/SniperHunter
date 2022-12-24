<template>
  <div
    id="loading"
    class="noselect"
  >
    <div class="lds-dual-ring">
      <img src="../../assets/icon.ico">
    </div>
    <span>LOADING</span>
    <!--
      <span
        id="loading"
        class="noselect"
      >LOADING...</span>
    -->
  </div>
</template>

<style scoped>
span {
  position: relative;
  top: 100px;
  color: var(--bg-alternate);
}
</style>
