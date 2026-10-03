/** Failure reason of a run without stream activity for the stall limit. */
export const RUN_STALLED = 'Run stalled without stream activity'

/**
 * Watches one run for a stall.
 *
 * Use when:
 * - A run owner must end work that stopped making progress, for example a provider that never answers.
 *
 * Expects:
 * - The owner calls `touch` on each stream event and `stop` when the run ends.
 *
 * Returns:
 * - `touch`, which restarts the stall timer, and `stop`, which clears it. `onExpire` runs at most once.
 */
export function superviseRun(limits: { stallTimeoutMs: number }, onExpire: (reason: string) => void) {
  let stopped = false
  let stall: ReturnType<typeof setTimeout> | undefined
  const expire = (reason: string) => {
    if (stopped)
      return
    stopped = true
    onExpire(reason)
  }
  stall = setTimeout(expire, limits.stallTimeoutMs, RUN_STALLED)

  return {
    touch() {
      if (stopped)
        return
      clearTimeout(stall)
      stall = setTimeout(expire, limits.stallTimeoutMs, RUN_STALLED)
    },
    stop() {
      stopped = true
      clearTimeout(stall)
    },
  }
}
