<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import { RouterView, useRouter } from 'vue-router'

import { fullscreenSurfaceOf } from './surfaces'

// The settings surface: the settings pages on the router of the main window, under the main page. The panel keeps the
// last settings route while another surface shows or the mode closes, so the page stays mounted and keeps its state.
const router = useRouter()
const route = shallowRef(router.currentRoute.value)
watch(() => router.currentRoute.value, (current) => {
  if (fullscreenSurfaceOf(current.path) === 'settings')
    route.value = current
})
</script>

<template>
  <RouterView v-if="fullscreenSurfaceOf(route.path) === 'settings'" :route="route" />
</template>
