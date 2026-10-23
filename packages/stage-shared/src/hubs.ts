/**
 * The hubs of the app. They sit side by side: the characters and the settings of the app.
 * Each hub owns the pages under one route prefix.
 */
export const hubIds = ['characters', 'settings'] as const

export type HubId = typeof hubIds[number]

/** The route prefix of each hub. */
export const hubRoutePrefixes: Record<HubId, string> = {
  characters: '/characters',
  settings: '/settings',
}

/**
 * The hub that a route path belongs to.
 *
 * Use when:
 * - A window or a surface decides whether a route is one of the hub pages, such as the settings window that shows
 *   every hub.
 *
 * Returns:
 * - The hub whose prefix is the path or a parent of it, or `undefined` for every other page.
 */
export function hubOfRoute(path: string): HubId | undefined {
  return hubIds.find(id => path === hubRoutePrefixes[id] || path.startsWith(`${hubRoutePrefixes[id]}/`))
}
