import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixture = path.join(root, 'tools/r2-ui-consistency');
const out = path.resolve(root, process.argv[process.argv.indexOf('--out') + 1] || '.review/WBT-DIRECTOR-REBASELINE-20260912/evidence/revision90-r2-harness');
const evidence = path.join(root, '.review/WBT-DIRECTOR-REBASELINE-20260912/evidence');
if (!out.startsWith(evidence + path.sep)) throw new Error('Output must be inside packet evidence');
for (const generated of [path.join(out, 'assets'), path.join(out, 'index.html')]) {
    fs.rmSync(generated, { recursive: true, force: true });
}
const adapters = path.join(fixture, 'adapters.ts');
const aliases = [
    ...['@/store/services', '@/store/global', '@/app/store/badge', '@/app/store/wps', '@/app/store/wshclientapi', '@/app/store/wshrpcutil'].map(find => ({ find, replacement: adapters })),
    ...Object.entries({ app: 'app', builder: 'builder', util: 'util', layout: 'layout', store: 'app/store', view: 'app/view', element: 'app/element', shadcn: 'app/shadcn', preview: 'preview' }).map(([key, value]) => ({ find: `@/${key}`, replacement: path.join(root, 'frontend', value) })),
];
const subjects = new Set();
await build({
    configFile: false, root: fixture, base: './',
    esbuild: { jsx: 'automatic', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', target: 'ES2022' } } },
    resolve: { alias: aliases },
    plugins: [{ name: 'subject-ledger', transform(_code, id) { if (path.isAbsolute(id.split('?')[0])) subjects.add(id.split('?')[0]); } }],
    build: { outDir: out, emptyOutDir: false, target: 'chrome140', minify: false },
});
for (const name of ['build.mjs', 'main.cjs', 'renderer.tsx', 'index.html', 'adapters.ts']) subjects.add(path.join(fixture, name));
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
for (const f of files(out).filter(f => /\.(html|css|js)$/.test(f))) subjects.add(f);
const entries = [...subjects].filter(fs.existsSync).sort().map(file => ({ path: path.relative(root, file).replaceAll('\\', '/'), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase() }));
fs.writeFileSync(path.join(out, 'subject-hashes.json'), JSON.stringify({ time: new Date().toISOString(), configFile: false, jsx: 'automatic', entries }, null, 2));
console.log('R2 harness built; subject files:', entries.length);
