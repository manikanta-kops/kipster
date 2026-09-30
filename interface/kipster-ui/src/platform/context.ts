import { createContext } from 'react'
import type { Platform } from './platform'
export const PlatformContext = createContext<Platform | null>(null)
