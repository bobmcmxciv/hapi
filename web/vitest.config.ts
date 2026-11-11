import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(process.env.HAPI_FORK_VERSION?.trim() || '0.27.1-dev'),
        __APP_COMMIT__: JSON.stringify('0'.repeat(40)),
    },
    plugins: [
        react(),
        {
            name: 'virtual-pwa-register-stub',
            resolveId(id) {
                if (id === 'virtual:pwa-register') return '\0virtual:pwa-register'
            },
            load(id) {
                if (id === '\0virtual:pwa-register') return 'export function registerSW() { return async () => {} }'
            },
        },
    ],
    resolve: {
        dedupe: ['react', 'react-dom'],
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
    test: {
        globals: false,
        environment: 'jsdom',
        include: ['src/**/*.test.{ts,tsx}'],
        setupFiles: ['./src/test/setup.ts'],
        teardownTimeout: 3000,
    },
})
