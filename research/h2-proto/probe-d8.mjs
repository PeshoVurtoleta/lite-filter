// d8 twin of probe.mjs (31-bit Smis). Args after `--`: <file> <member> <N>.
const [file, mem, N0, KS] = globalThis.arguments; const N = +N0;
// KS="smi31": keys >> 1, so every key is a Smi on 31-bit-Smi engines (isolates LIBRARY boxing from caller boxing).
const SH = KS === "smi31" ? 1 : 0;
const F = await import(file);
const keys = new Int32Array(4096); for (let i = 0; i < 4096; i++) keys[i] = (Math.imul(i + 1, 2654435761) >> SH);
let f, run, sink = 0;
const C = 8192;
if (mem === 'nop') run = (i) => { sink ^= keys[i & 4095]; };
else if (mem === 'XorFilter' || mem === 'BinaryFuse') { f = F[mem].from(Array.from(keys.subarray(0, 2048)), { keys: 'int' }); run = (i) => { if (f.has(keys[i & 4095])) sink++; }; }
else if (mem === 'Cuckoo' || mem === 'Quotient') { f = new F[mem](C, { keys: 'int' }); for (let i = 0; i < 2048; i++) f.add(keys[i]); run = (i) => { if (f.has(keys[i & 4095])) sink++; }; }
else { f = new F[mem](C, { keys: 'int' }); run = (i) => { const k = keys[i & 4095]; if (!f.has(k)) f.add(k); }; }
for (let i = 0; i < N; i++) run(i);
if (sink === 0.5) print(sink);
