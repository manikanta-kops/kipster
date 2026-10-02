import { createContext } from 'react'
import type { Platform } from '../platform/platform'
import {
  CoreSettingsClient,
  parseInterfaceChoices,
  type InterfaceChoices,
} from './core-settings'

export type InterfaceChange = Partial<Omit<InterfaceChoices, 'revision'>>

/**
 * The installation's interface choices as Core keeps them, so Kip and every
 * window share one palette, theme and desktop alert setting. It stays empty
 * until the connected Core advertises them; windows then use their own saved
 * choices.
 */
export class InterfacePreferences {
  private readonly client: CoreSettingsClient
  private current: InterfaceChoices | null = null
  private readonly listeners = new Set<() => void>()
  constructor(endpoint: string) {
    this.client = new CoreSettingsClient(endpoint)
  }
  /** Core's choices, or null while Core does not keep them. */
  get value() {
    return this.current
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  /** Applies a read, a save result or an `interface-changed` event; an older revision is ignored. */
  accept(value: unknown) {
    const next = parseInterfaceChoices(value)
    if (this.current && next.revision < this.current.revision) return
    this.current = next
    for (const listener of this.listeners) listener()
  }
  /**
   * Reads Core's choices. A choice Core never saved takes this window's own,
   * so Kip sees what the person sees.
   */
  async load(local: InterfaceChange, signal: AbortSignal) {
    this.accept(await this.client.interfacePreferences(signal))
    const current = this.current
    if (!current) return
    const missing = Object.fromEntries(
      Object.entries(local).filter(
        ([key, value]) =>
          value !== null &&
          value !== undefined &&
          current[key as keyof InterfaceChange] === null,
      ),
    )
    if (Object.keys(missing).length) await this.save(missing, signal)
  }
  /** Saves choices in Core. Without Core support it does nothing. */
  async save(change: InterfaceChange, signal = AbortSignal.timeout(15000)) {
    if (!this.current) return
    this.accept(await this.client.saveInterfacePreferences(change, signal))
  }
}

export const InterfacePreferencesContext =
  createContext<InterfacePreferences | null>(null)

/** This window's own desktop alert choice, used while Core keeps none. */
export const desktopAlertsKey = (scope: string) =>
  `desktop-notifications:${scope}`
/** Whether background desktop alerts are on: Core's choice when it keeps one, otherwise this window's. */
export function desktopAlertsEnabled(
  platform: Platform,
  preferences: InterfacePreferences | null,
  scope: string,
) {
  return (
    preferences?.value?.desktopNotifications ??
    platform.preferences.get(desktopAlertsKey(scope)) === 'enabled'
  )
}
