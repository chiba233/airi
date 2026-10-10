import type { Router } from 'vue-router'

import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { createMemoryHistory, createRouter, START_LOCATION, useRouter } from 'vue-router'

/** The settings home. The settings history starts here, so a page opened from elsewhere can always go back. */
const SETTINGS_HOME = '/settings'

/**
 * The settings surface of the fullscreen mode.
 *
 * Use when:
 * - The fullscreen mode prepares or resets its settings surface, or the settings panel renders the pages.
 *
 * Expects:
 * - Settings pages navigate with `router`, which the settings panel provides in place of the app router, so the main
 *   window never leaves its page and its stage.
 *
 * Returns:
 * - The router, and actions that route it and replace it with a fresh one.
 */
export const useFullscreenSettingsStore = defineStore('fullscreen-settings', () => {
  const appRouter = useRouter()

  function createSettingsRouter() {
    return createRouter({ history: createMemoryHistory(), routes: appRouter.options.routes })
  }

  /** The settings router, with a history of its own. It lasts while the fullscreen mode is active. */
  const router = shallowRef<Router>(createSettingsRouter())

  /**
   * Goes to `path`. A router that has not navigated yet starts its history at the settings home. Without `path`, a
   * router that already shows a page stays there, so switching back to settings returns to the page the user left.
   */
  async function route(path?: string) {
    const current = router.value
    if (current.currentRoute.value === START_LOCATION) {
      await current.push(SETTINGS_HOME)
      if (path && path !== SETTINGS_HOME)
        await current.push(path)
      return
    }
    if (path)
      await current.push(path)
  }

  /** Replaces the router with a fresh one, so the next fullscreen mode starts at the settings home. */
  function reset() {
    router.value = createSettingsRouter()
  }

  return { router, route, reset }
})
