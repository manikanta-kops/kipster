export type ApplicationUpdate =
  { kind: 'changed' } | { kind: 'connection'; message: string }
/** The workspace owns transport; panels subscribe only while mounted. */
export class ApplicationUpdates {
  private listeners = new Set<(update: ApplicationUpdate) => void>()
  subscribe(listener: (update: ApplicationUpdate) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  publish(update: ApplicationUpdate) {
    for (const listener of this.listeners) listener(update)
  }
}
