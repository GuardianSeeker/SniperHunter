<script lang="ts" setup>
import {ref} from 'vue';
import {openUrl, checkUpdate} from '#preload';

async function callUpdate() {
  updateText.value = 'Checking for Update...';
  const updateRequired = await checkUpdate();
  if (updateRequired) {
    updateText.value = 'Update required, going to download page in 3 seconds.';
    setTimeout(() => {
      openUrl('https://github.com/GuardianSeeker/SniperHunter/releases/latest/');
    }, 3000);
  }
  else {
    updateText.value = "You're running the latest version!";
  }
  setTimeout(() => {
    updateText.value = 'Check for Update';
  }, 3000);
}

const updateText = ref('Check for Update');
</script>

<template>
  <div>
    <h2>About</h2>
    <p>
      Sniper Hunter is a tool intended for Fortnite streamers who are frequently stream sniped to have a program at their
      disposal to keep track of that possibility. I don't stream myself, but I use it for just tracking games to see stats
      on the fly like how many real players, who killed me, profile lookups and the other features that I've added in.
      <br />
      <br />
      Got a suggestion? Message me on discord @Gun-Grave#8284 or let me know on
      <a
        href="#"
        @click="openUrl('https://github.com/GuardianSeeker/SniperHunter')"
      >GitHub</a>.
      <br />
      <br />
      Thank you for using Sniper Hunter! If you like my project and found it useful, you can donate to me through
      <a
        href="#"
        @click="openUrl('https://streamlabs.com/guardianseeker/tip')"
      >StreamLabs</a>.
    </p>
    <h2>Features</h2>
    <ul>
      <li>
        Game Tracker
        <ul>
          <li>Stats (partial for creative)</li>
          <li>Eliminations (w/ search)</li>
          <li>Placements</li>
        </ul>
      </li>
      <li>
        Player Tracker
        <ul>
          <li>Previous games</li>
          <li>
            Player details
            <ul>
              <li>Username</li>
              <li>Epic ID (useful for reporting)</li>
              <li>Platform</li>
              <li>
                Skin (<img
                  width="32"
                  src="../../assets/skins/epic.png"
                /> represents bots and <img
                  width="32"
                  src="../../assets/skins/sniper.png"
                />
                means the player was never within replay vision)
              </li>
            </ul>
          </li>
          <li>Stream snipe count</li>
          <li>Search</li>
        </ul>
      </li>
      <li>Automatic Replay Parsing</li>
      <li>Downloading latest skins</li>
    </ul>
    <h2>Credits</h2>
    <p>
      Shoutout to
      <a
        href="#"
        @click="openUrl('https://fortnite-api.com/')"
      >Fortnite API</a>
      for the skin icon images, and
      <a
        href="#"
        @click="openUrl('https://github.com/xNocken/replay-reader')"
      >xNocken</a>
      for the fortnite replay parser and
      <a
        href="#"
        @click="openUrl('https://github.com/cawa-93/vite-electron-builder')"
      >Alex Kozack</a>
      for the electron boilerplate.
    </p>
    <hr />
    <div style="text-align: center; margin-bottom: 6px;">
      <button
        style="width: 50%; height: 48px;"
        @click="callUpdate"
      >
        {{ updateText }}
      </button>
    </div>
  </div>
</template>
