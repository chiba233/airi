<script setup lang="ts">
import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { PageHeader } from '@proj-airi/stage-ui/components'
import { ref } from 'vue'
import { RouterView, useRoute } from 'vue-router'

import WindowTitleBar from '../components/Window/TitleBar.vue'

import { useRestoreScroll } from '../composables/use-restore-scroll'
import { useSettingsRouteHeader } from '../composables/use-settings-route-header'

const route = useRoute()
const scrollContainer = ref<HTMLElement>()
useRestoreScroll(scrollContainer)

// const activeSettingsTutorial = ref('default')
const routeHeaderMetadata = useSettingsRouteHeader(route)
</script>

<template>
  <div h-full w-full bg="$bg-color" flex="~ col">
    <WindowTitleBar :title="routeHeaderMetadata?.title ?? ''" icon="i-solar:settings-bold" />
    <div
      :style="{
        paddingTop: `44px`,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
      }"

      min-h-0 flex-1
    >
      <div ref="scrollContainer" relative h-full w-full overflow-y-auto scrollbar-none>
        <div flex="~ col" mx-auto h-full max-w-screen-xl>
          <PageHeader
            :title="routeHeaderMetadata?.title ?? ''"
            :subtitle="routeHeaderMetadata?.subtitle ?? ''"
            :disable-back-button="isStageTamagotchi() && route.path === '/settings'"
            px-4
          />
          <div min-h-0 flex-1 px-4>
            <RouterView />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
