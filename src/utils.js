// Utilidades compartidas.

// Aplica asyncFn a cada item de la lista con un maximo de `limit` en paralelo.
// Devuelve los resultados en el mismo orden que la entrada.
export async function mapLimit(items, limit, asyncFn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = { ok: true, value: await asyncFn(items[idx], idx) };
      } catch (err) {
        results[idx] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(workers);
  return results.map((r, i) => {
    if (r.ok) return r.value;
    throw r.error;
  });
}
