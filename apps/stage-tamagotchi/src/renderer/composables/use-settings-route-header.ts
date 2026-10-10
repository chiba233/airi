import type { RouteLocationNormalizedLoaded } from 'vue-router'

import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The header of a settings page: the title and subtitle from its route meta, or the provider name on a provider page.
 *
 * Use when:
 * - A surface shows settings pages with a header, such as the settings layout or the settings panel of the main window.
 *
 * Expects:
 * - `route` is reactive. Each surface passes the route that it shows.
 *
 * Returns:
 * - The header, or `undefined` when the route names no title.
 */
export function useSettingsRouteHeader(route: RouteLocationNormalizedLoaded) {
  const { t } = useI18n()
  const providersStore = useProviderStore()

  const providerTitle = computed(() => {
    if (!route.path.startsWith('/settings/providers/'))
      return undefined

    const segments = route.path.split('/').filter(Boolean)
    const providerId = segments[3]

    if (!providerId)
      return undefined

    return providersStore.findProviderDefinition(providerId)?.nameLocalize({ t })
  })

  return computed(() => {
    const { titleKey, subtitleKey, title, subtitle } = route.meta as {
      titleKey?: string
      subtitleKey?: string
      title?: string
      subtitle?: string
    }
    const resolvedTitle = titleKey ? t(titleKey) : title
    const resolvedSubtitle = subtitleKey ? t(subtitleKey) : subtitle

    if (resolvedTitle || resolvedSubtitle) {
      return {
        title: resolvedTitle,
        subtitle: resolvedSubtitle,
      }
    }

    if (providerTitle.value) {
      return {
        title: providerTitle.value,
        subtitle: t('settings.title'),
      }
    }

    return undefined
  })
}
