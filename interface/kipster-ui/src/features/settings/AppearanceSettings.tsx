import type { CSSProperties } from 'react'
import {
  isDarkOnly,
  palettes,
  type Appearance,
  type PaletteTone,
  type ThemeMode,
} from '../../app/appearance'
import { Icon } from '../../components/Icon'
import { Block, Row, Segmented } from './ui'

const modes: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
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

export function AppearanceSettings({
  appearance,
  device,
}: {
  appearance: Appearance
  /** What this device is called in copy, such as "Mac". */
  device: string
}) {
  const darkOnly = isDarkOnly(appearance.palette)
  const activeMode = darkOnly ? 'dark' : appearance.mode
  return (
    <>
      <Block label="Palette">
        <fieldset className="palette-picker" aria-label="Palette">
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
      </Block>
      <Block
        foot={
          darkOnly
            ? 'This palette is designed for dark mode only.'
            : `System follows your ${device}’s light or dark setting.`
        }
      >
        <Row
          label="Mode"
          control={
            <span className="mode-picker">
              <Segmented
                label="Mode"
                value={activeMode}
                options={modes}
                disabled={darkOnly}
                change={(mode) => appearance.setMode(mode)}
              />
            </span>
          }
        />
      </Block>
    </>
  )
}
