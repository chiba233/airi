import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { electronMainWindowFullscreenSurfaceChanged } from '../../shared/eventa'
import { useFullscreenSettingsStore } from './fullscreen-settings'
import { useMainWindowFullscreenStore } from './main-window-fullscreen'

const invokes = vi.hoisted(() => ({
  reportSurface: vi.fn(async () => {}),
}))

// The fullscreen mode tells the main process only what shows. Any other call, such as a chat mode change, fails here.
vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaInvoke: (event: unknown) => {
    if (event === electronMainWindowFullscreenSurfaceChanged)
      return invokes.reportSurface
    throw new Error('Unexpected invoke')
  },
}))

const Page = defineComponent({ render: () => null })

/** The stores inside an app with a router, which the settings surface reads its routes from. */
function setup() {
  const app = createApp(Page)
  app.use(createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Page },
      { path: '/settings', component: Page },
      { path: '/settings/airi-card', component: Page },
    ],
  }))
  app.use(createPinia())
  return app.runWithContext(() => ({ fullscreen: useMainWindowFullscreenStore(), settings: useFullscreenSettingsStore() }))
}

describe('main window fullscreen store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // A settings page that another window opens can always go back, because the history starts at the settings home.
  it('opens settings at a route with the settings home under it', async () => {
    const { fullscreen, settings } = setup()

    await fullscreen.open('settings', '/settings/airi-card')

    expect(fullscreen.phase).toBe('expanding')
    expect(fullscreen.surface).toBe('settings')
    expect(settings.router.currentRoute.value.path).toBe('/settings/airi-card')

    settings.router.back()
    await vi.waitFor(() => expect(settings.router.currentRoute.value.path).toBe('/settings'))
  })

  it('reports each surface while open, and nothing once it closes', async () => {
    const { fullscreen } = setup()
    await fullscreen.open('settings')
    fullscreen.settle('open')
    await fullscreen.open('chat')
    fullscreen.close()

    expect(invokes.reportSurface.mock.calls).toEqual([[{ surface: 'settings' }], [{ surface: 'chat' }], [{ surface: undefined }]])
    expect(fullscreen.phase).toBe('closing')
  })

  // Switching surfaces keeps the settings page, and closing starts the next opening at the settings home.
  it('returns to the settings page it left, until the mode closes', async () => {
    const { fullscreen, settings } = setup()
    await fullscreen.open('settings', '/settings/airi-card')
    fullscreen.settle('open')
    await fullscreen.open('chat')
    await fullscreen.open('settings')

    expect(settings.router.currentRoute.value.path).toBe('/settings/airi-card')

    fullscreen.close()
    fullscreen.settle('closed')
    await fullscreen.open('settings')

    expect(settings.router.currentRoute.value.path).toBe('/settings')
  })

  // Showing the chat in the fullscreen mode is not a choice of chat mode, so the saved chat mode stays as it is.
  it('shows the chat without changing the chat mode', async () => {
    const { fullscreen } = setup()

    await fullscreen.open('chat')

    expect(fullscreen.surface).toBe('chat')
    expect(fullscreen.phase).toBe('expanding')
  })

  it('shows the kept surface at once after a reload', async () => {
    const { fullscreen } = setup()

    await fullscreen.resume('chat')

    expect(fullscreen.phase).toBe('open')
    expect(fullscreen.surface).toBe('chat')
    expect(invokes.reportSurface).toHaveBeenCalledWith({ surface: 'chat' })
  })
})
