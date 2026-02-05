import { defineConfig } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'


export default defineConfig({
  main: {
    publicDir: path.join(__dirname, 'resources', 'main'),
    plugins: [tailwindcss()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          main: path.join(__dirname, 'src', 'main', 'main.js'),
          worker: path.join(__dirname, 'src', 'main', 'worker.ts'),
          cli: path.join(__dirname, 'src', 'main', 'cli.ts'),
        }
      },
      sourcemap: true
    }
  },
  preload: {
    plugins: [tailwindcss()],
    build: {
        outDir: 'dist/preload',
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
    base: './',
    publicDir: path.join(__dirname, 'resources', 'renderer'),
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src')
      }
    },
    build: {
      outDir: 'dist/renderer',
      sourcemap: true,
      rollupOptions: {
        input: {
          index: path.join(__dirname, 'src', 'renderer', 'index.html'),
          application: path.join(__dirname, 'src', 'renderer', 'application.html'),
          floatpage: path.join(__dirname, 'src', 'renderer', 'floatpage.html')
        }
      }
    }
  }
})