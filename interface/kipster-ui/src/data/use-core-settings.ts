import type { ApplicationUpdates } from './application-updates'
import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { TextHttpError, type Scope } from './text.js'
import {
  applyLearningEvent,
  mergeAdapterList,
  mergeAgentLearning,
  mergeLearning,
  mergePermissions,
  mergeSettingsRecord,
  mergeSettingsSnapshot,
  type AdapterList,
  type CoreSettingsClient,
  type Directory,
  type Learning,
  type PermissionMode,
  type Permissions,
  type SavedSettings,
  type SettingsPatch,
  type SettingsTarget,
} from './core-settings.js'

const wait = (signal: AbortSignal, time: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, time)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

/** An updater that keeps the newer permission record; a missing one keeps what is held. */
const newer =
  (next: Permissions | null) =>
  (held: Permissions | null): Permissions | null =>
    next ? mergePermissions(held, next) : held

/**
 * Loads saved settings, adapters, learning, the permission mode (when Core advertises it) and
 * the directory, then follows the application stream while mounted. Every merge checks
 * revisions, so a replayed or late update never replaces newer state.
 */
export function useCoreSettings(
  client: CoreSettingsClient,
  scope: Scope,
  updates?: ApplicationUpdates,
  permissionModes = false,
) {
  const queries = useQueryClient()
  const [saved, setSaved] = useState<SavedSettings | null>(null)
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  const readPermissions = useCallback(
    (signal: AbortSignal) =>
      permissionModes ? client.permissions(signal) : Promise.resolve(null),
    [client, permissionModes],
  )
  const keepPermissions = (next: Permissions | null) =>
    setPermissions(newer(next))
  const [adapters, setAdapters] = useState<AdapterList | null>(null)
  const [adapterError, setAdapterError] = useState('')
  const [learning, setLearning] = useState<Learning | null>(null)
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [connection, setConnection] = useState('Loading settings…')
  const [attempt, setAttempt] = useState(0)
  const { installationId, callerId } = scope
  const effectiveChanged = useCallback(
    () =>
      void queries.invalidateQueries({
        queryKey: ['core-effective', client.endpoint],
      }),
    [queries, client],
  )

  useEffect(() => {
    const abort = new AbortController()
    const signal = abort.signal
    const scope = { installationId, callerId }
    if (updates) {
      let streamMessage = ''
      let dirty = false
      let loading = false
      let retry: ReturnType<typeof setTimeout> | undefined
      const refresh = async () => {
        dirty = true
        if (loading || signal.aborted) return
        loading = true
        try {
          while (dirty && !signal.aborted) {
            dirty = false
            const [
              snapshot,
              list,
              nextLearning,
              nextDirectory,
              nextPermissions,
            ] = await Promise.all([
              client.settings(signal),
              client.adapters(signal).catch((error: unknown) => {
                if (
                  error instanceof TextHttpError &&
                  error.code === 'unavailable'
                )
                  return error.message
                throw error
              }),
              client.learning(signal),
              client.directory(signal),
              readPermissions(signal),
            ])
            if (signal.aborted) return
            setSaved((held) => mergeSettingsSnapshot(held, snapshot))
            setPermissions(newer(nextPermissions))
            if (typeof list === 'string') setAdapterError(list)
            else {
              setAdapterError('')
              setAdapters((held) => mergeAdapterList(held, list))
            }
            setLearning((held) => mergeLearning(held, nextLearning))
            setDirectory(nextDirectory)
            setConnection(streamMessage)
            effectiveChanged()
          }
        } catch (error) {
          if (!signal.aborted) {
            setConnection(
              error instanceof Error
                ? error.message
                : 'Settings are unavailable. Retrying…',
            )
            retry = setTimeout(() => void refresh(), 2000)
          }
        } finally {
          loading = false
        }
      }
      // Subscribe before reading. Updates arriving during a read schedule another read,
      // so opening a panel cannot miss a mutation between its snapshots and subscription.
      const unsubscribe = updates.subscribe((update) => {
        if (update.kind === 'connection') streamMessage = update.message
        if (update.kind === 'connection' && update.message)
          setConnection(update.message)
        else {
          clearTimeout(retry)
          void refresh()
        }
      })
      void refresh()
      return () => {
        unsubscribe()
        clearTimeout(retry)
        abort.abort()
      }
    }
    let cursor: string | null = null
    let failures = 0
    const reloadDirectory = () =>
      client
        .directory(signal)
        .then(setDirectory)
        .catch(() => {})
    const reloadLearning = () =>
      client
        .learning(signal)
        .then((next) => setLearning((held) => mergeLearning(held, next)))
        .catch(() => {})
    void (async () => {
      while (!signal.aborted) {
        try {
          if (!cursor) {
            // The settings cursor is read first, so following the stream from it cannot miss a
            // change reflected in the reads after it.
            const snapshot = await client.settings(signal)
            const [list, nextLearning, nextDirectory, nextPermissions] =
              await Promise.all([
                client.adapters(signal).catch((error: unknown) => {
                  if (
                    error instanceof TextHttpError &&
                    error.code === 'unavailable'
                  )
                    return error.message
                  throw error
                }),
                client.learning(signal),
                client.directory(signal),
                readPermissions(signal),
              ])
            if (signal.aborted) return
            setSaved((held) => mergeSettingsSnapshot(held, snapshot))
            setPermissions(newer(nextPermissions))
            if (typeof list === 'string') setAdapterError(list)
            else {
              setAdapterError('')
              setAdapters((held) => mergeAdapterList(held, list))
            }
            setLearning((held) => mergeLearning(held, nextLearning))
            setDirectory(nextDirectory)
            effectiveChanged()
            cursor = snapshot.cursor
          }
          setConnection('')
          await client.events(scope, cursor, signal, (event) => {
            if (signal.aborted) return
            if (event.kind === 'settings') {
              setSaved((held) =>
                held ? mergeSettingsRecord(held, event.record) : held,
              )
              effectiveChanged()
            } else if (event.kind === 'adapters') {
              setAdapters((held) => mergeAdapterList(held, event.list))
              setAdapterError('')
              effectiveChanged()
            } else if (event.kind === 'learning') {
              setLearning((held) =>
                held ? applyLearningEvent(held, event) : held,
              )
              // Whether each agent learns also depends on the installation switch.
              void reloadLearning()
            } else if (event.kind === 'permissions')
              setPermissions(newer(event.permissions))
            else if (event.kind === 'directory') void reloadDirectory()
            cursor = event.cursor
            failures = 0
          })
        } catch (error) {
          if (signal.aborted) return
          if (error instanceof TextHttpError && error.code === 'incompatible') {
            setConnection(error.message)
            return
          }
          if (
            error instanceof TextHttpError &&
            error.code === 'resync-required'
          )
            cursor = null
          setConnection(
            cursor
              ? 'Live settings interrupted. Reconnecting…'
              : error instanceof TextHttpError
                ? `${error.message} Retrying…`
                : 'Settings are unavailable. Retrying…',
          )
          await wait(
            signal,
            Math.min(10000, 500 * 2 ** Math.min(failures++, 5)),
          )
        }
      }
    })()
    return () => abort.abort()
  }, [
    client,
    installationId,
    callerId,
    attempt,
    effectiveChanged,
    updates,
    readPermissions,
  ])

  const saveSettings = async (
    target: SettingsTarget,
    id: string,
    operationId: string,
    patch: SettingsPatch,
  ) => {
    const result = await client.saveSettings(
      target,
      id,
      operationId,
      patch,
      AbortSignal.timeout(20000),
    )
    setSaved((held) => (held ? mergeSettingsRecord(held, result) : held))
    effectiveChanged()
    return result
  }
  const refreshAdapters = async () => {
    const list = await client.refreshAdapters(AbortSignal.timeout(60000))
    setAdapters((held) => mergeAdapterList(held, list))
    setAdapterError('')
    effectiveChanged()
  }
  const saveLearning = async (update: {
    enabled?: boolean
    sleepTime?: string
  }) => {
    const next = await client.saveLearning(update, AbortSignal.timeout(20000))
    setLearning((held) => mergeLearning(held, next))
  }
  const saveAgentLearning = async (
    agentId: string,
    update: { enabled?: boolean; sleepTime?: string | null },
  ) => {
    const next = await client.saveAgentLearning(
      agentId,
      update,
      AbortSignal.timeout(20000),
    )
    setLearning((held) => (held ? mergeAgentLearning(held, next) : held))
  }
  const savePermissions = async (mode: PermissionMode) => {
    keepPermissions(
      await client.savePermissions({ mode }, AbortSignal.timeout(20000)),
    )
  }
  const removeAlwaysAllowed = async (id: string) => {
    keepPermissions(
      await client.savePermissions(
        { removeAlwaysAllowed: [id] },
        AbortSignal.timeout(20000),
      ),
    )
  }
  return {
    saved,
    adapters,
    adapterError,
    learning,
    permissions,
    savePermissions,
    removeAlwaysAllowed,
    directory,
    connection,
    reconnect: () => setAttempt((n) => n + 1),
    saveSettings,
    refreshAdapters,
    saveLearning,
    saveAgentLearning,
  }
}
