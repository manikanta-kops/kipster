import { useState } from 'react'
import {
  permissionModes,
  type PermissionMode,
  type Permissions,
} from '../../data/core-settings'
import { errorText } from './format'
import { Block, Callout, Confirm } from './ui'

const options: Record<PermissionMode, { label: string; description: string }> =
  {
    supervised: {
      label: 'Supervised',
      description: 'Ask before commands and file changes.',
    },
    acceptEdits: {
      label: 'Auto-accept edits',
      description: 'Auto-approve edits, ask before other actions.',
    },
    auto: {
      label: 'Auto',
      description:
        'Supported providers approve routine actions; others still ask.',
    },
    fullAccess: {
      label: 'Full access',
      description: 'Allow commands and edits without prompts.',
    },
  }

/** The installation's permission mode as four choices. Full access asks for a confirmation first. */
export function PermissionSettings({
  permissions,
  save,
}: {
  permissions: Permissions
  save: (mode: PermissionMode) => Promise<void>
}) {
  const [state, setState] = useState<
    'idle' | 'confirm' | { saving: PermissionMode } | { error: string }
  >('idle')
  const known = (permissionModes as readonly string[]).includes(
    permissions.mode,
  )
  const saving = typeof state === 'object' && 'saving' in state
  const choose = async (mode: PermissionMode) => {
    if (mode === permissions.mode) return setState('idle')
    if (mode === 'fullAccess' && state !== 'confirm') return setState('confirm')
    setState({ saving: mode })
    try {
      await save(mode)
      setState('idle')
    } catch (error) {
      setState({ error: errorText(error) })
    }
  }
  // The choice being confirmed or saved shows as chosen until Core answers.
  const shown =
    state === 'confirm'
      ? 'fullAccess'
      : saving
        ? state.saving
        : permissions.mode
  return (
    <>
      {!known && (
        <Callout tone="wait">
          Kipster uses a permission mode this app does not recognize. Choose one
          below to replace it.
        </Callout>
      )}
      <Block
        label="Permission mode"
        foot="Applies to every kip from its next turn. Auto is the default. Requests that still need you appear in the chat as approvals."
      >
        <fieldset
          className="set-choices"
          disabled={saving}
          aria-label="Permission mode"
        >
          {permissionModes.map((mode) => (
            <label key={mode} className="set-row set-choice permission-option">
              <input
                type="radio"
                name="permission-mode"
                value={mode}
                aria-label={options[mode].label}
                aria-describedby={`permission-${mode}`}
                checked={shown === mode}
                onChange={() => void choose(mode)}
              />
              <span className="set-text">
                <span className="set-title">{options[mode].label}</span>
                <small id={`permission-${mode}`}>
                  {options[mode].description}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
      </Block>
      {typeof state === 'object' && 'error' in state && (
        <p role="alert" className="set-alert">
          Not saved: {state.error}
        </p>
      )}
      {state === 'confirm' && (
        <Confirm title="Allow full access?" cancel={() => setState('idle')}>
          <div className="set-confirm-form">
            <p>
              Full access lets every kip run commands and change files without
              asking you.
            </p>
            <div className="set-confirm-actions">
              <button className="set-button" onClick={() => setState('idle')}>
                Cancel
              </button>
              <button
                className="set-button danger solid"
                onClick={() => void choose('fullAccess')}
              >
                Allow full access
              </button>
            </div>
          </div>
        </Confirm>
      )}
    </>
  )
}
