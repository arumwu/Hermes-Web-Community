import { build, version } from 'esbuild';
import { readdir, mkdir, readFile, writeFile, copyFile, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, 'web');
const output = join(root, 'build', 'web');
for (const directory of [join(root, 'build'), output]) {
  const entry = await lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error(`Unsafe generated directory: ${directory}`);
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const files = (await readdir(source)).filter(name => /\.(html|css|js|svg|png|webmanifest)$/.test(name)).sort();
const manifest = {};
for (const name of files) {
  if (!(await lstat(join(source, name))).isFile()) throw new Error(`Not a regular asset: ${name}`);
  if (['app.js', 'sw.js', 'styles.css'].includes(name)) {
    await build({ entryPoints: [join(source, name)], outfile: join(output, name),
      bundle: name === 'app.js', minify: true, charset: 'utf8',
      target: ['safari16', 'chrome110'], platform: 'browser', legalComments: 'inline' });
  } else await copyFile(join(source, name), join(output, name));
}
let html = await readFile(join(output, 'index.html'), 'utf8');
for (const name of ['app.js', 'styles.css']) {
  const hash = createHash('sha256').update(await readFile(join(output, name))).digest('hex');
  html = html.replaceAll(`${name}"`, `${name}?v=${hash.slice(0, 16)}"`);
}
await writeFile(join(output, 'index.html'), html);
// Version the shell cache from the compiled assets so later deployments replace it.
const shellHash = createHash('sha256');
for (const name of files.filter(name => name !== 'sw.js')) shellHash.update(await readFile(join(output, name)));
const worker = (await readFile(join(output, 'sw.js'), 'utf8')).replace(/hermes-web-static-v\d+/, `hermes-web-${shellHash.digest('hex').slice(0, 16)}`);
await writeFile(join(output, 'sw.js'), worker);
for (const name of files) manifest[name] = createHash('sha256').update(await readFile(join(output, name))).digest('hex');
const receipt = { compiler: `esbuild ${version}`, target: ['safari16', 'chrome110'], assets: manifest };
await writeFile(join(root, 'build', 'web-build-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`WEB_BUILD_SUCCEEDED: ${files.length} assets, esbuild ${version}`);
