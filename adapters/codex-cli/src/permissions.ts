import type { PermissionMode } from '@kipster/core/adapter'

/** Codex asks for every kind of approval it can prompt for; a disabled kind would be rejected without asking. */
type Granular = { readonly granular: { readonly sandbox_approval: true; readonly rules: true; readonly mcp_elicitations: true; readonly request_permissions: true; readonly skill_approval: true } }

/** The Codex App Server thread settings that carry out one Kipster permission mode. */
export interface CodexPermissions {
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly approvalPolicy: 'untrusted' | 'never' | Granular
  /** `auto_review` routes approval requests to Codex's reviewer subagent instead of the person. */
  readonly approvalsReviewer: 'user' | 'auto_review'
  readonly config?: { readonly 'sandbox_workspace_write.network_access': true }
}

/**
 * Asks like `on-request`, and also when the sandbox blocks a command, such as a write outside the workspace.
 * Plain `on-request` lets such a command fail without asking.
 */
const askOutsideSandbox: Granular = { granular: { sandbox_approval: true, rules: true, mcp_elicitations: true, request_permissions: true, skill_approval: true } }

/** The workspace-write sandbox blocks network by default, and a blocked network call fails without asking. */
const network = { 'sandbox_workspace_write.network_access': true } as const

/**
 * `untrusted` asks before every file change and every command Codex does not know to be read-only, so supervised can
 * use the workspace-write sandbox: an approved command then runs with network, which a read-only sandbox blocks. With
 * the granular policy, edits inside the writable roots and sandboxed commands run without asking. The reviewer is
 * always set, so a reviewer chosen in the user's Codex configuration does not change what a mode means.
 */
const modes: Readonly<Record<PermissionMode, CodexPermissions>> = {
  supervised: { sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user', config: network },
  acceptEdits: { sandbox: 'workspace-write', approvalPolicy: askOutsideSandbox, approvalsReviewer: 'user', config: network },
  auto: { sandbox: 'workspace-write', approvalPolicy: askOutsideSandbox, approvalsReviewer: 'auto_review', config: network },
  fullAccess: { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' },
}

/** The thread settings for a permission mode. A missing or unknown mode is supervised, the safest. */
export function codexPermissions(mode: unknown): CodexPermissions {
  return typeof mode === 'string' && Object.hasOwn(modes, mode) ? modes[mode as PermissionMode] : modes.supervised
}
