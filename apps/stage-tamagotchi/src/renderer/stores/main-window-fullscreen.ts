import type { MainWindowFullscreenSurface } from '../../shared/eventa'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { electronMainWindowFullscreenSurfaceChanged } from '../../shared/eventa'
import { fullscreenSurfaces } from '../components/fullscreen/surfaces'

/**
 * Where the fullscreen mode of the main window is.
 *
 * - `closed`: nothing of the fullscreen mode is mounted.
 * - `expanding`: the window grows over its display, and the stage keeps its place on screen.
 * - `open`: the stage sits on the left, and the surface shows on the right.
 * - `closing`: the stage returns to its place, then the window shrinks back.
 */
export type MainWindowFullscreenPhase = 'closed' | 'expanding' | 'open' | 'closing'

/**
 * The fullscreen mode of the main window: the window covers its display, and a surface from
 * {@link fullscreenSurfaces} shows beside the character.
 *
 * Use when:
 * - An entry point opens a surface, the island switches it, or the main page runs the open and close transitions.
 *
 * Expects:
 * - The main page moves the window and the stage, and reports the end of each transition through `settle`.
 *
 * Returns:
 * - The phase, the surface, and actions that open, resume, close, and settle the mode.
 */
export const useMainWindowFullscreenStore = defineStore('main-window-fullscreen', () => {
  const reportSurface = useElectronEventaInvoke(electronMainWindowFullscreenSurfaceChanged)

  const phase = ref<MainWindowFullscreenPhase>('closed')
  /** What shows on the right while the mode is active. */
  const surface = ref<MainWindowFullscreenSurface>('settings')
  const active = computed(() => phase.value !== 'closed')

  /** Tells the main process what shows, which it needs to hand the chat draft over and to restore after a reload. */
  function report(shown: MainWindowFullscreenSurface | undefined) {
    void reportSurface({ surface: shown }).catch(error => console.error('[Main window fullscreen] Failed to report the surface:', error))
  }

  /** Shows a surface, opening the mode when it is closed. `route` goes to the surface, such as a settings page. */
  async function open(next: MainWindowFullscreenSurface, route?: string) {
    await fullscreenSurfaces[next].prepare?.(route)
    surface.value = next
    if (phase.value === 'closed')
      phase.value = 'expanding'
    else if (phase.value === 'open')
      report(next)
  }

  /** Shows the mode at once, without a transition, when the main window kept it across a page reload. */
  async function resume(shown: MainWindowFullscreenSurface) {
    if (phase.value !== 'closed')
      return
    await fullscreenSurfaces[shown].prepare?.()
    surface.value = shown
    phase.value = 'open'
    report(shown)
  }

  function close() {
    if (phase.value !== 'open')
      return
    phase.value = 'closing'
    // The surface unmounts as the transition starts, so the chat has no composer to collect from any more.
    report(undefined)
  }

  /** Ends a transition. A closed mode resets every surface, so the next opening starts fresh. */
  function settle(state: 'open' | 'closed') {
    phase.value = state
    if (state === 'open') {
      report(surface.value)
      return
    }
    for (const definition of Object.values(fullscreenSurfaces))
      definition.reset?.()
  }

  return { phase, surface, active, open, resume, close, settle }
})
