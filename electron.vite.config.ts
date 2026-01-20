import { defineConfig } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'


export default defineConfig({
  main: {
    publicDir: path.join(__dirname, 'resources', 'main'),
    plugins: [tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          main: path.join(__dirname, 'src', 'main', 'main.js'),
          worker: path.join(__dirname, 'src', 'main', 'worker.ts'),
        }
      },
      sourcemap: true
    }
  },
  preload: {
    plugins: [tailwindcss()],
    build: {
        rollupOptions: {
            input: {
                index: path.join(__dirname, 'src', 'renderer', 'preload.js')
            },
            output: {
                format: "cjs",
                entryFileNames: "[name].js",
            }
        },
        sourcemap: true
    }
  },
  renderer: {
    publicDir: path.join(__dirname, 'resources', 'renderer'),
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src')
      }
    },
    build: {
      sourcemap: true
    }
  }
})