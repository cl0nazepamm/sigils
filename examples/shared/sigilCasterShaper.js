// sigilCasterShaper.js — caustic-engine caster shaper for sigil meshes.
//
// The chrome sigil material displaces vertices PROCEDURALLY in TSL
// (peakHeight × height-profile × dome, driven by the aDepth/aGrad/aDome
// attributes) — the CPU-side geometry stays flat. Photon emission must see
// the same surface the camera does, so this factory bakes the identical
// displacement (and its analytic normal) into the engine's world-space
// caster upload: engine.setCasterMesh(mesh, { shaper: sigilCasterShaper(mesh) }).
//
// The master engine lives in speedball (speedball-gi/caustics); this file
// owns ONLY the sigil-specific height model.

export function sigilCasterShaper(mesh) {
    const geo = mesh.geometry;
    const depthAttr = geo.getAttribute('aDepth');
    const gradAttr = geo.getAttribute('aGrad');
    const domeAttr = geo.getAttribute('aDome');
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const sigilMeta = mat?.userData?.sigil ?? {};
    const peakUniform = mat?.sigilUniforms?.peakHeight;
    const peakHeight = Number(peakUniform?.value ?? sigilMeta.peakHeight ?? 0);
    const profile = sigilMeta.profile === 'round' ? 'round' : 'linear';
    if (!depthAttr || !gradAttr || !domeAttr || peakHeight === 0) return null;

    return {
        // Local-space position: extrude along +Z by the stroke height field.
        position(v, i) {
            const rawDepth = Math.max(0, depthAttr.getX(i));
            const dome = domeAttr.getX(i);
            const depth = profile === 'round' ? Math.min(1, rawDepth) : rawDepth;
            const heightProfile = profile === 'round'
                ? Math.sqrt(Math.max(1e-5, depth * (2 - depth)))
                : depth;
            v.z += peakHeight * heightProfile * dome;
        },
        // Local-space analytic normal of the displaced surface (dome faces
        // only); returns false on flat vertices so the engine falls back to
        // the geometry's own normal attribute.
        normal(n, i) {
            if (domeAttr.getX(i) <= 0.5) return false;
            const rawDepth = Math.max(0, depthAttr.getX(i));
            const depth = profile === 'round' ? Math.min(1, rawDepth) : rawDepth;
            const s = Math.sqrt(Math.max(1e-5, depth * (2 - depth)));
            const dHdd = profile === 'round' ? peakHeight * (1 - depth) / s : peakHeight;
            n.set(
                -dHdd * gradAttr.getX(i),
                -dHdd * gradAttr.getY(i),
                1,
            ).normalize();
            return true;
        },
    };
}
