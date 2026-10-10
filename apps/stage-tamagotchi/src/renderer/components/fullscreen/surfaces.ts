import type { Component } from 'vue'

import type { MainWindowFullscreenSurface } from '../../../shared/eventa'

import { defineAsyncComponent } from 'vue'

import { useFullscreenSettingsStore } from '../../stores/fullscreen-settings'

/**
 * A surface that the fullscreen mode can show beside the character. The mode, its island, and the main page read only
 * this registry, so a new surface needs one entry here and its id in {@link MainWindowFullscreenSurface}.
 */
export interface FullscreenSurface {
  /** The icon of its island button. */
  icon: string
  /** The i18n key of its island button. */
  label: string
  /** The panel on the right. It loads when the surface first shows. */
  panel: Component
  /** Runs before the surface shows. `route` comes from the request that opens it, such as a settings entry point. */
  prepare?: (route?: string) => Promise<void>
  /** Runs when the fullscreen mode closes, so the next opening starts fresh. */
  reset?: () => void
}

export const fullscreenSurfaces: Record<MainWindowFullscreenSurface, FullscreenSurface> = {
  settings: {
    icon: 'i-solar:settings-minimalistic-outline',
    label: 'tamagotchi.stage.fullscreen-island.settings',
    panel: defineAsyncComponent(() => import('./settings-panel.vue')),
    prepare: route => useFullscreenSettingsStore().route(route),
    reset: () => useFullscreenSettingsStore().reset(),
  },
  // Showing the chat here leaves the chat mode alone. Only the chat style menu changes it.
  chat: {
    icon: 'i-solar:chat-line-outline',
    label: 'tamagotchi.stage.fullscreen-island.chat',
    panel: defineAsyncComponent(() => import('./chat-panel.vue')),
  },
}
