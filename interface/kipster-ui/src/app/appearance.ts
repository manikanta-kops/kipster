import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { Platform } from '../platform/platform'
import type { InterfacePreferences } from '../data/interface-preferences'

/**
 * Palettes are defined once in `styles/themes.css`. Adding a palette is one CSS
 * block keyed by `data-palette` plus one entry here with its preview tones and
 * surface style.
 */
export const palettes = [
  {
    id: 'glacier',
    name: 'Glacier',
    surface: 'glass',
    light: { canvas: '#d2e3ee', tint: '#1170b0' },
    dark: { canvas: '#08131d', tint: '#62c3f0' },
  },
  {
    id: 'alpenglow',
    name: 'Alpenglow',
    surface: 'glass',
    light: { canvas: '#f0d9dc', tint: '#c4386a' },
    dark: { canvas: '#1a0d16', tint: '#ff8cb0' },
  },
  {
    id: 'pine',
    name: 'Pine',
    surface: 'glass',
    light: { canvas: '#d6e2dc', tint: '#1f6f53' },
    dark: { canvas: '#0a1512', tint: '#6fd3a6' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    surface: 'glass',
    light: { canvas: '#dcdcde', tint: '#93681c' },
    dark: { canvas: '#111113', tint: '#e3b766' },
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    surface: 'outline',
    light: null,
    dark: { canvas: '#000000', tint: '#f5f5f7' },
  },
] as const satisfies readonly {
  id: string
  name: string
  surface: Surface
  /** Canvas and tint used for the settings preview; `null` means dark only. */
  light: PaletteTone | null
  dark: PaletteTone
}[]

/**
 * How panels and cards are drawn: frosted `glass` over the scenery, or opaque
 * `outline` surfaces with hairline edges and LED-style status marks.
 */
export type Surface = 'glass' | 'outline'
export interface PaletteTone {
  canvas: string
  tint: string
}
export type Palette = (typeof palettes)[number]
export type PaletteId = Palette['id']
export type ThemeMode = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'
export interface Appearance {
  palette: PaletteId
  mode: ThemeMode
  theme: Theme
  setPalette: (palette: PaletteId) => void
  setMode: (mode: ThemeMode) => void
}

export const isDarkOnly = (id: PaletteId) =>
  palettes.find((p) => p.id === id)?.light === null

export const defaultPalette: PaletteId = 'alpenglow'
const darkQuery = '(prefers-color-scheme: dark)'

const isPalette = (value: string | null): value is PaletteId =>
  palettes.some((p) => p.id === value)
const isMode = (value: string | null): value is ThemeMode =>
  value === 'system' || value === 'light' || value === 'dark'

function subscribeToScheme(onChange: () => void) {
  const query = window.matchMedia?.(darkQuery)
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}
const systemPrefersDark = () => window.matchMedia?.(darkQuery).matches ?? false

/**
 * Palette and light/dark mode. With `preferences`, they follow the choices
 * Core keeps for the installation, which Kip can change too. Platform
 * preferences keep the last choice for the first paint.
 */
export function useAppearance(
  platform: Platform,
  preferences: InterfacePreferences | null = null,
): Appearance {
  const [palette, setPaletteState] = useState<PaletteId>(() => {
    const saved = platform.preferences.get('palette')
    return isPalette(saved) ? saved : defaultPalette
  })
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = platform.preferences.get('theme')
    return isMode(saved) ? saved : 'system'
  })
  const systemDark = useSyncExternalStore(
    subscribeToScheme,
    systemPrefersDark,
    () => false,
  )
  // A choice saved in Core, here, by Kip or in another window, applies at once.
  useEffect(
    () =>
      preferences?.subscribe(() => {
        const shared = preferences.value
        const sharedPalette = shared?.palette ?? null
        const sharedMode = shared?.theme ?? null
        if (isPalette(sharedPalette)) {
          setPaletteState(sharedPalette)
          platform.preferences.set('palette', sharedPalette)
        }
        if (isMode(sharedMode)) {
          setModeState(sharedMode)
          platform.preferences.set('theme', sharedMode)
        }
      }),
    [platform, preferences],
  )
  const darkOnly = isDarkOnly(palette)
  const theme: Theme =
    darkOnly || (mode === 'system' ? systemDark : mode === 'dark')
      ? 'dark'
      : 'light'

  // The document root carries the theme so dialogs in the top layer match.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.palette = palette
    root.dataset.surface =
      palettes.find((p) => p.id === palette)?.surface ?? 'glass'
    root.dataset.theme = theme
  }, [palette, theme])

  const setPalette = useCallback(
    (next: PaletteId) => {
      setPaletteState(next)
      platform.preferences.set('palette', next)
      void preferences?.save({ palette: next }).catch(() => undefined)
    },
    [platform, preferences],
  )
  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next)
      platform.preferences.set('theme', next)
      void preferences?.save({ theme: next }).catch(() => undefined)
    },
    [platform, preferences],
  )
  return { palette, mode, theme, setPalette, setMode }
}

/** Named agent colors with a matching `--hue-*` token in themes.css. */
export const agentHues = [
  'iris',
  'rose',
  'mint',
  'sky',
  'amber',
  'sage',
  'ocean',
  'plum',
] as const
export type AgentHue = (typeof agentHues)[number]

export const isAgentHue = (color: string | undefined): color is AgentHue =>
  agentHues.includes(color as AgentHue)

/** CSS color for an agent's `color` field, falling back to iris. */
export const hueVar = (color: string | undefined) =>
  `var(--hue-${isAgentHue(color) ? color : 'iris'})`

/** Groups have no stored color; derive a stable one from their position. */
const groupHues: AgentHue[] = ['rose', 'sky', 'sage', 'amber', 'iris', 'ocean']
export const groupHue = (index: number) =>
  `var(--hue-${groupHues[index % groupHues.length]})`
