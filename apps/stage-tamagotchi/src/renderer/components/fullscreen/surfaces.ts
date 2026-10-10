import type { Component } from 'vue'
import type { Router, RouteRecordRaw } from 'vue-router'

import type { MainWindowFullscreenSurface } from '../../../shared/eventa'

import { defineAsyncComponent } from 'vue'

/** The settings home. A settings page that opens from outside settings keeps it under itself in the history. */
const SETTINGS_HOME = '/settings'

/**
 * A surface that the fullscreen mode can show beside the character. The mode, its island, and the main page read only
 * this registry, so a new surface needs one entry here and its id in {@link MainWindowFullscreenSurface}.
 */
export interface FullscreenSurface {
  /** The icon of its island button. */
  icon: string
  /** The i18n key of its island button. */
  label: string
  /**
   * The panel on the right. It mounts the first time the surface shows and stays mounted until the mode closes, so
   * switching to another surface and back keeps what it holds, such as an unsent message or an unsaved form.
   */
  panel: Component
  /**
   * Route paths of the app that belong to the surface. The main window router puts these routes under the main page,
   * so the page and its stage stay while the surface navigates.
   */
  prefixes?: string[]
  /** Runs before the surface shows. `page` comes from the request that opens it, such as a settings entry point. */
  prepare?: (context: { router: Router, page?: string }) => Promise<void>
}

export const fullscreenSurfaces: Record<MainWindowFullscreenSurface, FullscreenSurface> = {
  settings: {
    icon: 'i-solar:settings-minimalistic-outline',
    label: 'tamagotchi.stage.fullscreen-island.settings',
    panel: defineAsyncComponent(() => import('./settings-panel.vue')),
    // Devtools pages open from the developer settings, so they show in the same surface.
    prefixes: ['/settings', '/devtools'],
    // Settings stay on the page they show unless a request names another one, so switching back returns to it.
    async prepare({ router, page }) {
      const inSettings = fullscreenSurfaceOf(router.currentRoute.value.path) === 'settings'
      if (inSettings && !page)
        return
      if (!inSettings && page && page !== SETTINGS_HOME)
        await router.push(SETTINGS_HOME)
      await router.push(page ?? SETTINGS_HOME)
    },
  },
  chat: {
    icon: 'i-solar:chat-line-outline',
    label: 'tamagotchi.stage.fullscreen-island.chat',
    panel: defineAsyncComponent(() => import('./chat-panel.vue')),
  },
}

/** The surface that a route path belongs to, or `undefined` for the main page and every other page. */
export function fullscreenSurfaceOf(path: string): MainWindowFullscreenSurface | undefined {
  for (const [id, surface] of Object.entries(fullscreenSurfaces)) {
    if (surface.prefixes?.some(prefix => path === prefix || path.startsWith(`${prefix}/`)))
      return id as MainWindowFullscreenSurface
  }
  return undefined
}

/**
 * Puts the routes of every surface under the main page, for the router of the main window.
 *
 * Use when:
 * - The main window page creates its router. Other windows keep the app routes as they are.
 *
 * Expects:
 * - The app routes after `setupLayouts`, where the main page sits in the stage layout at `/`.
 *
 * Returns:
 * - The routes with each surface route as a child of the main page. A child keeps its absolute path, so the URL is the
 *   same, and the main page stays mounted while the route moves between it and a surface.
 */
export function nestFullscreenSurfaces(routes: RouteRecordRaw[]): RouteRecordRaw[] {
  const stage = routes.find(route => route.path === '/')
  const page = stage?.children?.find(route => route.path === '/')
  if (!stage?.children || !page)
    throw new Error('The main page route is missing, so the fullscreen surfaces have no page to sit under')

  const surfaceRoutes = routes.filter(route => fullscreenSurfaceOf(route.path))
  const nestedPage = { ...page, children: [...(page.children ?? []), ...surfaceRoutes] } as RouteRecordRaw
  const nestedStage = { ...stage, children: stage.children.map(child => child === page ? nestedPage : child) } as RouteRecordRaw
  return routes
    .filter(route => !fullscreenSurfaceOf(route.path))
    .map(route => route === stage ? nestedStage : route)
}
