import { createContext } from 'react'
import type { MediaClient } from './media'
import type { WorkspaceManagement } from './management'
import type { Documents } from '../features/documents/store'

export const WorkspaceContext = createContext<{
  connectionKey: string
  media: MediaClient
  management: WorkspaceManagement
  /** Present when the connected Core supports rich docs. */
  documents?: Documents | null
} | null>(null)
