import type { PermissionMode } from '@kipster/core/adapter'

/** The Codex App Server thread settings that carry out one Kipster permission mode. */
export interface CodexPermissions {
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly approvalPolicy: 'untrusted' | 'on-request' | 'never'
  /** `auto_review` routes approval requests to Codex's reviewer subagent instead of the person. */
  readonly approvalsReviewer: 'user' | 'auto_review'
}

/**
 * `untrusted` asks before file changes and before every command Codex does not know to be read-only. `on-request`
 * with a workspace-write sandbox applies edits inside the writable roots and runs sandboxed commands, asking only
 * to leave the sandbox. The reviewer is always set, so a reviewer chosen in the user's Codex configuration does not
 * change what a mode means.
 */
const modes: Readonly<Record<PermissionMode, CodexPermissions>> = {
  supervised: { sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
  acceptEdits: { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
  fullAccess: { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' },
}

/** The thread settings for a permission mode. A missing or unknown mode is supervised, the safest. */
export function codexPermissions(mode: unknown): CodexPermissions {
  return typeof mode === 'string' && Object.hasOwn(modes, mode) ? modes[mode as PermissionMode] : modes.supervised
}
