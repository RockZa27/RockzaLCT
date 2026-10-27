// Packaging driver for electron-builder.
//
// WHY A STAGING DIRECTORY (pnpm layout decision)
// electron-builder walks the *production dependency tree* of the app. In this
// monorepo that tree contains the workspace packages (@rockzalct/*), which pnpm
// symlinks to ../../packages/*, i.e. outside apps/desktop. electron-builder then
// aborts ("... must be under .../apps/desktop/"). Those packages are already
// bundled into out/main by electron-vite, so they must not ship anyway.
//
// We therefore run `pnpm deploy --legacy --prod` into <repo>/.stage/desktop. That
// produces a self-contained project: only production dependencies, resolved
// from pnpm-lock.yaml (reproducible), with every symlink pointing inside the
// staged directory. electron-builder runs there, and the `files` filter in
// package.json drops the staged @rockzalct/* copies. This leaves the developer
// install untouched (no global node-linker=hoisted, no extra .npmrc), so
// `pnpm install/typecheck/test/build` behave exactly as before.
//
// Native modules: @novastar/serial -> serialport -> @serialport/bindings-cpp ships
// N-API prebuilds (prebuilds/win32-x64/*.node, ABI-stable across Electron
// versions). They are asar-unpacked (see "asarUnpack"), so npmRebuild is off:
// compiling from source would only add a toolchain dependency on CI.
// ROCKZALCT_SKIP_REBUILD=1 is kept as an explicit override.
//
// Usage: node scripts/dist.mjs [electron-builder args...]   (e.g. --win nsis --x64)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appDir, '../..');
const stageDir = join(repoRoot, '.stage', 'desktop');
const require = createRequire(join(appDir, 'package.json'));

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n"${cmd} ${args.join(' ')}" failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(join(appDir, 'out', 'main', 'index.js'))) {
  console.error('apps/desktop/out is missing. Run `pnpm build` first.');
  process.exit(1);
}

rmSync(join(repoRoot, '.stage'), { recursive: true, force: true });
mkdirSync(join(repoRoot, '.stage'), { recursive: true });
run('pnpm', ['--filter', '@rockzalct/desktop', 'deploy', '--legacy', '--prod', stageDir], repoRoot);

const electronVersion = JSON.parse(
  readFileSync(require.resolve('electron/package.json'), 'utf8'),
).version;
const builderCli = require.resolve('electron-builder/cli.js');
const extra = process.env.ROCKZALCT_SKIP_REBUILD === '1' ? ['-c.npmRebuild=false'] : [];

run(
  process.execPath,
  [builderCli, ...process.argv.slice(2), '--publish', 'never', `-c.electronVersion=${electronVersion}`, ...extra],
  stageDir,
);

// Bring the results back next to the app so the path is stable: apps/desktop/release
const outDir = join(appDir, 'release');
rmSync(outDir, { recursive: true, force: true });
cpSync(join(stageDir, 'release'), outDir, { recursive: true });
console.log('\nArtifacts in apps/desktop/release:');
for (const f of readdirSync(outDir)) console.log('  ' + f);
