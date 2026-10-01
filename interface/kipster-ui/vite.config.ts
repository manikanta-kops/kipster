import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { demoServer } from './tests/demo-server.ts'
import pkg from './package.json' with { type: 'json' }

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const test = mode === 'test'
  return {
    define: {
      __KIPSTER_DEMO__: JSON.stringify(test || mode === 'demo'),
      __KIPSTER_TEST__: JSON.stringify(test),
      __KIPSTER_APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [react(), ...(test ? [demoServer()] : [])],
    base: './',
    build: {
      rolldownOptions: {
        ...(test && {
          input: ['index.html', 'tests/desktop.html'],
        }),
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'react',
                test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              },
            ],
          },
        },
      },
    },
    clearScreen: false,
    server: {
      hmr: test ? false : undefined,
      host: '127.0.0.1',
      strictPort: true,
      watch: { ignored: ['**/src-tauri/**'] },
    },
    preview: { host: '127.0.0.1', strictPort: true },
  }
})
