const [,, file, mem, N0] = process.argv; const N = +N0;
const F = await import(file);
const keys = new Int32Array(4096); for (let i = 0; i < 4096; i++) keys[i] = (Math.imul(i + 1, 2654435761) | 0);
let f, run, sink = 0;
const C = 8192;
if (mem === 'nop') run = (i) => { sink ^= keys[i & 4095]; };
else if (mem === 'XorFilter' || mem === 'BinaryFuse') { f = F[mem].from(Array.from(keys.subarray(0, 2048)), { keys: 'int' }); run = (i) => { if (f.has(keys[i & 4095])) sink++; }; }
else if (mem === 'Cuckoo' || mem === 'Quotient') { f = new F[mem](C, { keys: 'int' }); for (let i = 0; i < 2048; i++) f.add(keys[i]); run = (i) => { if (f.has(keys[i & 4095])) sink++; }; }
else { f = new F[mem](C, { keys: 'int' }); run = (i) => { const k = keys[i & 4095]; if (!f.has(k)) f.add(k); }; }
for (let i = 0; i < N; i++) run(i);
if (sink === 0.5) console.log(sink);
