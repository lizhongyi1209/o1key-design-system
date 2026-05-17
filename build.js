// Build script: compile app.jsx → app.min.js
const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: [path.join(__dirname, 'app', 'app.jsx')],
  outfile: path.join(__dirname, 'app', 'app.min.js'),
  loader: { '.jsx': 'jsx' },
  jsx: 'transform',       // JSX → React.createElement
  target: 'es2020',
  format: 'iife',
  minify: true,
  bundle: true,
  sourcemap: false,
  legalComments: 'none',
};

if (watch) {
  esbuild.context(opts).then(ctx => {
    console.log('[build] Watching for changes...');
    return ctx.watch();
  }).catch(() => process.exit(1));
} else {
  esbuild.build(opts).then(() => {
    console.log('[build] Done: app/app.min.js');
  }).catch(() => process.exit(1));
}
