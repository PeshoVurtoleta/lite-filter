const A = await import(new URL('./Filter.orig.js', import.meta.url));
const B = await import(new URL('./Filter.v3.js', import.meta.url));
const MEM = ['Bloom', 'CountingBloom', 'BlockedBloom', 'Cuckoo', 'Quotient', 'XorFilter', 'BinaryFuse'];
let seed = 7; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) | 0);
const intKeys = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(rnd()); a.push(-2147483648, 2147483647, 0, -1, 1); return a; };
const strKeys = (n) => { const a = []; for (let i = 0; i < n; i++) a.push('sig:' + rnd().toString(36) + ':' + i); return a; };
let checks = 0, fails = 0;
const eq = (x, y, what) => { checks++; const sx = JSON.stringify(x), sy = JSON.stringify(y); if (sx !== sy) { fails++; if (fails < 10) console.log('DIFF', what, sx.slice(0, 120), '|', sy.slice(0, 120)); } };
for (const mem of MEM) for (const mode of ['int', 'str']) for (const sd of [undefined, 1, 0xdeadbeef, 0x80000000]) {
  const ins = mode === 'int' ? intKeys(3000) : strKeys(3000);
  const probe = mode === 'int' ? intKeys(50000) : strKeys(50000);
  const opts = mode === 'int' ? { keys: 'int' } : {};
  if (sd !== undefined) opts.seed = sd;
  let fa, fb;
  if (mem === 'XorFilter' || mem === 'BinaryFuse') { fa = A[mem].from(ins, { ...opts }); fb = B[mem].from(ins, { ...opts }); }
  else {
    fa = new A[mem](4096, { ...opts }); fb = new B[mem](4096, { ...opts });
    for (const k of ins) { let ea = null, eb = null; try { fa.add(k); } catch (e) { ea = e.message; } try { fb.add(k); } catch (e) { eb = e.message; } eq(ea, eb, mem + ' add-throw'); }
    if (typeof fa.remove === 'function') for (let i = 0; i < ins.length; i += 3) { let ra, rb; try { ra = fa.remove(ins[i]); } catch (e) { ra = 'T'; } try { rb = fb.remove(ins[i]); } catch (e) { rb = 'T'; } eq(ra, rb, mem + ' remove'); }
  }
  const ha = probe.map((k) => fa.has(k)), hb = probe.map((k) => fb.has(k));
  eq(ha, hb, mem + '/' + mode + '/seed' + sd + ' has');
  eq([fa.size, fa.seed, fa.capacity], [fb.size, fb.seed, fb.capacity], mem + ' getters');
  if (typeof fa.dump === 'function') eq(fa.dump(), fb.dump(), mem + '/' + mode + ' dump');
}
console.log('parity checks', checks, 'fails', fails);
