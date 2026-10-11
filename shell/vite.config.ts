import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'rushes-loopback-development-csp',
      transformIndexHtml: {
        order: 'post',
        handler(html, context) {
          if (!context.server) return html;
          const nonce = randomBytes(18).toString('base64');
          const port = context.server.config.server.port ?? 5173;
          return html
            .replace("script-src 'self';", `script-src 'self' 'nonce-${nonce}';`)
            .replace("connect-src 'self';", `connect-src 'self' ws://127.0.0.1:${port};`)
            .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
        },
      },
    },
  ],
  base: './',
  root: '.',
  build: { outDir: 'dist/renderer' },
  server: { port: 5173, strictPort: true },
});
