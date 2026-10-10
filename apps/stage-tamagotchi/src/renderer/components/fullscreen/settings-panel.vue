<script setup lang="ts">
import type { RouteLocationNormalizedLoaded } from 'vue-router'

import { PageHeader } from '@proj-airi/stage-ui/components'
import { computed, provide, shallowReactive } from 'vue'
import { routeLocationKey, routerKey, RouterView, routerViewLocationKey, START_LOCATION, viewDepthKey } from 'vue-router'

import { useSettingsRouteHeader } from '../../composables/use-settings-route-header'
import { useFullscreenSettingsStore } from '../../stores/fullscreen-settings'

// The settings router of the fullscreen mode. The mode prepares it before this surface shows, and replaces it only
// after the mode closes and this panel is gone.
const { router } = useFullscreenSettingsStore()

// The panel provides its router the way `app.use(router)` provides the app router, so `useRouter`, `useRoute`,
// `RouterLink`, and `RouterView` inside it all follow the panel history and leave the main window route alone.
const panelRouteFields = {} as RouteLocationNormalizedLoaded
for (const key of Object.keys(START_LOCATION) as (keyof RouteLocationNormalizedLoaded)[]) {
  Object.defineProperty(panelRouteFields, key, {
    get: () => router.currentRoute.value[key],
    enumerable: true,
  })
}
const route = shallowReactive(panelRouteFields)
provide(routerKey, router)
provide(routeLocationKey, route)
provide(routerViewLocationKey, router.currentRoute)
// The app routes wrap each page in layouts, and the settings layout belongs to the settings window. The panel draws its
// own frame, so its view starts at the page under the last layout. The layout plugin marks its records with `isLayout`.
provide(viewDepthKey, computed(() => router.currentRoute.value.matched.findLastIndex(record => record.meta.isLayout) + 1))

const header = useSettingsRouteHeader(route)
// The settings layout gives its pages a header, and the plain layout leaves the page to draw its own, like the card
// editor does. The panel does the same for each page.
const showsHeader = computed(() => route.meta.layout === 'settings')
</script>

<template>
  <div
    :class="[
      'h-full w-full flex flex-col',
      'rounded-3xl',
      'bg-white dark:bg-neutral-950',
      'shadow-2xl shadow-neutral-900/10',
      'overflow-hidden',
    ]"
  >
    <PageHeader
      v-if="showsHeader"
      :title="header?.title ?? ''"
      :subtitle="header?.subtitle ?? ''"
      :disable-back-button="route.path === '/settings'"
      :class="['px-8 pt-6']"
    />
    <div :class="['relative min-h-0 flex-1', 'overflow-y-auto', 'px-8 pb-8', showsHeader ? '' : 'pt-6']">
      <RouterView />
    </div>
  </div>
</template>
