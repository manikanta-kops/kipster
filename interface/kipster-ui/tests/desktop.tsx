import { createRoot } from 'react-dom/client'
import { ConnectedApp } from '../src/features/workspace/ConnectionSetup'
import { PlatformContext } from '../src/platform/context'
import { resolvePlatform } from '../src/platform/resolve'
import { History, Settings } from './desktop-harness'
import '../src/styles/app.css'

const platform = await resolvePlatform()
createRoot(document.getElementById('root')!).render(
  <PlatformContext.Provider value={platform}>
    {location.search.includes('history') ? (
      <History />
    ) : location.search.includes('settings') ? (
      <Settings platform={platform} />
    ) : (
      <ConnectedApp />
    )}
  </PlatformContext.Provider>,
)
