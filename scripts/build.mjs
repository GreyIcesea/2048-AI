// Reuse the upstream release binary; V8 validates/compiles the WASM locally.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
mkdirSync('engine', { recursive: true });
const src = readFileSync('upstream/docs/worker.js', 'utf8');
const start = src.indexOf('function ReverseLR(');
const end = src.indexOf('let current_time_limit_ratio');
if (start < 0 || end < start) throw Error('Upstream worker layout changed; review the extraction boundaries.');
const strategy = src.slice(start, end);
// Keep every upstream strategy function intact. Only replace browser messaging.
writeFileSync('engine/strategy.js', `// GENERATED from upstream/docs/worker.js; GPL-3.0. Do not edit.\nimport createAICore from './ai_core.js';\nlet ai_core;\n${strategy}\nexport async function initialize() { ai_core = await createAICore(); return { ai_core, CoreAILogic }; }\n`);
for (const file of ['ai_core.js', 'ai_core.wasm']) copyFileSync(`upstream/docs/${file}`, `engine/${file}`);
copyFileSync('upstream/LICENSE', 'LICENSE');
const wasm = readFileSync('engine/ai_core.wasm');
await WebAssembly.compile(wasm);
const manifest = {
  repository: 'https://github.com/game-difficulty/2048EndgameTablebase',
  commit: execFileSync('git', ['-C', 'upstream', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  wasmBytes: wasm.length,
  wasmSha256: createHash('sha256').update(wasm).digest('hex'),
  strategySha256: createHash('sha256').update(strategy).digest('hex'),
  builtAt: new Date().toISOString(),
};
writeFileSync('engine/manifest.json', JSON.stringify(manifest, null, 2));
console.log('Upstream Standalone AI ready; WASM compiled successfully.', manifest);
