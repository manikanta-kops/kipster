import { createContext } from 'react'
import type { MediaClient } from './media'
import type { WorkspaceManagement } from './management'

export const WorkspaceContext = createContext<{
  connectionKey: string
  media: MediaClient
  management: WorkspaceManagement
} | null>(null)
