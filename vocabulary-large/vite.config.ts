import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    server: {
      proxy: {
        '/vocabulary-api': {
          target: `http://127.0.0.1:${env.VOCABULARY_PORT || '8790'}`,
          rewrite: path => path.replace(/^\/vocabulary-api/, ''),
        },
      },
    },
  }
})
