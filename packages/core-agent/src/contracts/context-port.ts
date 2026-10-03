import type { ContextMessage } from '../types/chat'

export interface AgentContextPort {
  ingest: (envelope: ContextMessage) => void
  /** Projects the context that the identified session may read. Diagnostic snapshots cannot enter a model request. */
  snapshot: (sessionId: string) => Record<string, ContextMessage[]>
  reset: () => void
}
