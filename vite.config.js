import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/, so every asset URL needs
  // the repo prefix. Local dev and the capture harness serve from the root, so
  // this is opt-in via the build script (OW_PAGES=1).
  base: process.env.OW_PAGES ? '/Claude-of-Duty/' : '/',
  // Bind IPv4 explicitly: the default `localhost` binds ::1 only on macOS,
  // which the capture harness (127.0.0.1) cannot reach.
  // `hmr: false` when the capture harness owns the server (OW_NO_HMR=1): a file
  // saved by a concurrently-working agent otherwise reloads the page mid-capture
  // and playwright fails with "Execution context was destroyed".
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: process.env.OW_NO_HMR ? false : undefined,
  },
  preview: { host: '127.0.0.1' },
  // No sourcemap on the Pages build: it is 5.4 MB against a 1.4 MB bundle, and
  // an iPad on home wifi should not download it to look at a street.
  build: { target: 'es2022', sourcemap: !process.env.OW_PAGES, chunkSizeWarningLimit: 4096 },
  // Large binary game assets served verbatim.
  assetsInclude: ['**/*.ktx2', '**/*.hdr', '**/*.exr', '**/*.bin', '**/*.glb'],
});
