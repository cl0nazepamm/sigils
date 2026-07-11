/**
 * Build exact, insertion-ordered triangle adjacency without allocating one Set
 * per vertex. Marching-squares meshes have small degrees, so a short linear
 * duplicate check is substantially cheaper than tens of thousands of Sets.
 *
 * @param {number} count
 * @param {ArrayLike<number>} indices
 * @returns {number[][]}
 */
export function buildNeighborLists(count, indices) {
  const neighbors = Array.from({ length: count }, () => []);

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    addUnique(neighbors[a], b); addUnique(neighbors[a], c);
    addUnique(neighbors[b], a); addUnique(neighbors[b], c);
    addUnique(neighbors[c], a); addUnique(neighbors[c], b);
  }

  return neighbors;
}

/** Append while preserving Set insertion semantics. */
export function addUnique(list, value) {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === value) return false;
  }
  list.push(value);
  return true;
}
