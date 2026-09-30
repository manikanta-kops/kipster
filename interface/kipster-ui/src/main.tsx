import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { resolvePlatform, usesOverlayTitleBar } from './platform/resolve'
import { PlatformContext } from './platform/context'
import { MotionConfig } from 'motion/react'
import { paneSpring } from './app/motion'
import { ConnectedApp } from './features/workspace/ConnectionSetup'
import './styles/app.css'

if (usesOverlayTitleBar())
  document.documentElement.classList.add('titlebar-overlay')

const platform = await resolvePlatform()
if (__KIPSTER_TEST__)
  (await import('../tests/browser-bootstrap')).prepareBrowser(platform)
let demoURL: string | undefined
if (__KIPSTER_DEMO__) {
  const { createFakeCore, installFakeCoreTransport, DEMO_ORIGIN } =
    await import('./fake-core')
  const core = __KIPSTER_TEST__
    ? undefined
    : createFakeCore({ testControls: true })
  const handler = __KIPSTER_TEST__
    ? (await import('../tests/browser-bootstrap')).sharedHandler
    : core!.handle
  demoURL = __KIPSTER_TEST__
    ? (await import('../tests/browser-bootstrap')).testOrigin()
    : DEMO_ORIGIN
  const uninstall = installFakeCoreTransport(handler, demoURL)
  if (__KIPSTER_TEST__)
    (await import('../tests/browser-bootstrap')).markTransportReady()
  import.meta.hot?.dispose(() => {
    uninstall()
    core?.dispose()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user" transition={paneSpring}>
      <PlatformContext.Provider value={platform}>
        <ConnectedApp demoURL={demoURL} />
      </PlatformContext.Provider>
    </MotionConfig>
  </StrictMode>,
)
