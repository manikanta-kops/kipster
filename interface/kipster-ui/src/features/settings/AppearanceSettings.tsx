import type { CSSProperties } from 'react'
import {
  isDarkOnly,
  palettes,
  type Appearance,
  type PaletteTone,
  type ThemeMode,
} from '../../app/appearance'
import { Icon } from '../../components/Icon'

const modes: { id: ThemeMode; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

function PreviewHalf({ tone, dark }: { tone: PaletteTone; dark: boolean }) {
  return (
    <span
      className={`preview-half ${dark ? 'dark' : 'light'}`}
      style={
        { '--pv-canvas': tone.canvas, '--pv-tint': tone.tint } as CSSProperties
      }
    >
      <span className="preview-window">
        <span className="preview-dot" />
        <span className="preview-line" />
        <span className="preview-line short" />
      </span>
    </span>
  )
}

export function AppearanceSettings({ appearance }: { appearance: Appearance }) {
  const darkOnly = isDarkOnly(appearance.palette)
  const activeMode = darkOnly ? 'dark' : appearance.mode
  return (
    <div className="appearance-settings">
      <fieldset className="palette-picker">
        <legend className="group-label">Palette</legend>
        {palettes.map((palette) => (
          <label key={palette.id} className="palette-card">
            <input
              type="radio"
              name="palette"
              value={palette.id}
              checked={appearance.palette === palette.id}
              onChange={() => appearance.setPalette(palette.id)}
            />
            <span
              className={`palette-preview ${palette.light ? '' : 'dark-only'}`}
              aria-hidden="true"
            >
              {palette.light && (
                <PreviewHalf tone={palette.light} dark={false} />
              )}
              <PreviewHalf tone={palette.dark} dark />
              <span className="palette-check">
                <Icon name="check" size={12} weight="bold" />
              </span>
            </span>
            <span className="palette-name">
              {palette.name}
              {!palette.light && <small>Dark only</small>}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset
        className="mode-picker"
        disabled={darkOnly}
        style={
          {
            '--active': modes.findIndex((m) => m.id === activeMode),
          } as CSSProperties
        }
      >
        <legend className="group-label">Mode</legend>
        <div className="segmented">
          <span className="segmented-thumb" aria-hidden="true" />
          {modes.map((mode) => (
            <label key={mode.id}>
              <input
                type="radio"
                name="theme-mode"
                value={mode.id}
                checked={activeMode === mode.id}
                onChange={() => appearance.setMode(mode.id)}
              />
              {mode.label}
            </label>
          ))}
        </div>
        <p className="group-note">
          {darkOnly
            ? 'This palette is designed for dark mode only.'
            : 'System follows your device’s light or dark setting.'}
        </p>
      </fieldset>
    </div>
  )
}
