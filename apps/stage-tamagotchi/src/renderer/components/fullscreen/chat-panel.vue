<script setup lang="ts">
import { ChatSessionsDrawer } from '@proj-airi/stage-ui/components'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { storeToRefs } from 'pinia'
import { shallowRef, useTemplateRef } from 'vue'

import ChatSpeechMuteButton from '../chat-window/chat-speech-mute-button.vue'
import ChatWindowStyleMenu from '../chat-window/chat-window-style-menu.vue'
import InteractiveArea from '../InteractiveArea.vue'

import { useChatDraftHandover } from '../../composables/use-chat-draft-handover'

// The legacy chat window, inside the fullscreen mode. The header takes the place of its title bar, because the
// panel is not a window to drag.
const { activeCard } = storeToRefs(useAiriCardStore())
const sessionsDrawerOpen = shallowRef(false)
const interactiveArea = useTemplateRef<InstanceType<typeof InteractiveArea>>('interactive-area')

useChatDraftHandover(interactiveArea)
</script>

<template>
  <div
    :class="[
      'h-full w-full flex flex-col',
      'rounded-3xl',
      'bg-neutral-50 dark:bg-neutral-950',
      'shadow-2xl shadow-neutral-900/10',
      'overflow-hidden',
    ]"
  >
    <div :class="['flex items-center', 'gap-2', 'px-4 py-2']">
      <button
        type="button"
        :class="[
          'flex cursor-pointer select-none items-center gap-2 rounded-md px-1.5 py-0.5',
          'transition-all duration-200 ease-in-out',
          'hover:bg-neutral-200 dark:hover:bg-neutral-800',
        ]"
        @click="sessionsDrawerOpen = true"
      >
        <div :class="['i-solar:chat-line-bold', 'text-neutral-400 dark:text-neutral-500']" />
        <span :class="['whitespace-nowrap text-sm']">{{ activeCard?.name || 'AIRI' }}</span>
      </button>
      <div :class="['flex-1']" />
      <ChatSpeechMuteButton />
      <ChatWindowStyleMenu />
    </div>
    <InteractiveArea
      ref="interactive-area"
      :class="['min-h-0 w-full flex-1']"
    />
    <ChatSessionsDrawer v-model="sessionsDrawerOpen" />
  </div>
</template>
