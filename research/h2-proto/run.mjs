import { spawnSync } from 'node:child_process';
const D = new URL('.', import.meta.url).pathname;
const N = 200000;
const cnt = (file, mem, n, noinl) => {
  const a = ['--trace-gc', '--min-semi-space-size=4', '--max-semi-space-size=4'];
  if (noinl) a.push('--max-inlined-bytecode-size=0');
  const r = spawnSync(process.execPath, [...a, D + 'probe.mjs', D + file, mem, String(n)], { encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) return 'ERR ' + (r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' | ');
  return (r.stdout.match(/Scavenge/g) || []).length;
};
const files = process.argv[2].split(',');
for (const mem of ['nop', 'Bloom', 'CountingBloom', 'BlockedBloom', 'Cuckoo', 'Quotient', 'XorFilter', 'BinaryFuse']) {
  const row = [mem.padEnd(13)];
  for (const f of files) for (const ni of [false, true]) row.push(f.replace('Filter.', '').replace('.js', '') + (ni ? ':noinl ' : ':inl ') + cnt(f, mem, N, ni) + '->' + cnt(f, mem, 8 * N, ni));
  console.log(row.join('  '));
}
