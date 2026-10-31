// Bundles the server into dist/index.js for `pnpm start`, so production needs no TypeScript runner
// (tsx is a dev dependency and is gone after `pnpm i --prod`). The workspace package
// @deskhaven/shared is TypeScript source and is bundled in; every other package stays external and
// is loaded from node_modules at runtime (native modules, the Agent SDK and its bundled CLI).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'external-node-modules',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@deskhaven/') ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
