import en from '@proj-airi/i18n/locales/en'

import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-vue'
import { createI18n } from 'vue-i18n'

import ChatBackgroundTasks from './background-tasks.vue'

describe('chat background tasks', () => {
  // A background task is visible and stoppable from the composer.
  it('lists each task and asks to stop the chosen one', async () => {
    const screen = await render(ChatBackgroundTasks, {
      props: { tasks: [{ sessionId: 'recipe-session', turnId: 'turn-1', recipeName: 'Research' }] },
      global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
    })

    expect(screen.container.textContent).toContain('Working on')
    expect(screen.container.textContent).toContain('Research')

    await screen.getByRole('button', { name: 'Stop Research' }).click()

    expect(screen.emitted('stop')).toEqual([[{ sessionId: 'recipe-session', turnId: 'turn-1', recipeName: 'Research' }]])
  })
})
