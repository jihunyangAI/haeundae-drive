import { defineConfig } from 'vite';

// Relative asset paths, so the built game works from any folder of a static host.
// The development server does not watch what is generated or downloaded (the built game, map files by the
// hundred, raw map data, test screenshots): watching them kept it busy to no purpose.
export default defineConfig({
  base: './',
  server: { watch: { ignored: ['**/dist/**', '**/data/**', '**/public/map/**', '**/public/people/**', '**/public/radio/**', '**/.playwright-mcp/**', '**/.omc/**', '**/docs/**'] } },
});
