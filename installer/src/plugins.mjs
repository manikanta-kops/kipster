import { join } from 'node:path'

export const pluginsPackage = '@kipster/plugins'

/**
 * Names the plugin server in host.json only once its channel has released it, so an update
 * never needs a package the channel lacks. Without a release the configuration stays as it is
 * and Kipster runs without plugins.
 */
export function withPlugins(config, home, released) {
  if (!released) return { config, report: `${pluginsPackage} has no release on this channel yet; Kipster runs without plugins.` }
  return { config: { ...config, plugins: { module: join(home, 'current/node_modules', pluginsPackage, 'dist/server/cli.js') } }, report: null }
}
