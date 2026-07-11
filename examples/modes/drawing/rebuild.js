/**
 * Drawing mode preview meshes + coalesced merged-field rebuild.
 */

import {
  buildSparseCurveGeometry,
  buildSigilGeometryAsync,
} from '../../../src/index.js';
import { sparsePreviewOptionsFromState } from '../../shared/sigilDefaults.js';
import {
  activeBuildPaths,
  buildOptionsForSession,
  clampCvRadiusScale,
  committedBuildPaths,
  expandActivePaths,
  sampleSplinePoints,
} from '../../shared/strokeSession.js';

/**
 * @param {object} deps
 * @param {typeof import('three')} deps.THREE
 * @param {() => object} deps.getState
 * @param {() => object[]} deps.getStrokes
 * @param {() => object|null} deps.getDraft
 * @param {() => object|null} deps.getDrag
 * @param {() => boolean} deps.getDrawing
 * @param {() => object[]} deps.getCurrent
 * @param {() => boolean} deps.getHoldPreviewUntilRebuild
 * @param {(v: boolean) => void} deps.setHoldPreviewUntilRebuild
 * @param {() => boolean} deps.getComputeFailed
 * @param {(v: boolean) => void} deps.setComputeFailed
 * @param {() => string} deps.getBlendBackend
 * @param {(v: string) => void} deps.setBlendBackend
 * @param {(v: string) => void} deps.setLastError
 * @param {() => number} deps.getRebuildVersion
 * @param {(v: number) => void} deps.setRebuildVersion
 * @param {() => boolean} deps.getRebuildQueued
 * @param {(v: boolean) => void} deps.setRebuildQueued
 * @param {() => boolean} deps.getRebuildRunning
 * @param {(v: boolean) => void} deps.setRebuildRunning
 * @param {() => number} deps.getBuildingCount
 * @param {(v: number) => void} deps.setBuildingCount
 * @param {() => number} deps.getVertexCount
 * @param {(v: number) => void} deps.setVertexCount
 * @param {import('three').Mesh} deps.sigilMesh
 * @param {import('three').Mesh} deps.draftMesh
 * @param {import('three').Mesh} deps.dragMesh
 * @param {import('three').Mesh} deps.freehandMesh
 * @param {*} deps.computeRenderer
 * @param {*} deps.photon
 * @param {*} deps.pathTrace
 * @param {AbortSignal} deps.signal
 */
export function createDrawingRebuild(deps) {
  const {
    THREE,
    getState,
    getStrokes,
    getDraft,
    getDrag,
    getDrawing,
    getCurrent,
    getHoldPreviewUntilRebuild,
    setHoldPreviewUntilRebuild,
    getComputeFailed,
    setComputeFailed,
    setBlendBackend,
    setLastError,
    getRebuildVersion,
    setRebuildVersion,
    getRebuildQueued,
    setRebuildQueued,
    getRebuildRunning,
    setRebuildRunning,
    getBuildingCount,
    setBuildingCount,
    setVertexCount,
    sigilMesh,
    draftMesh,
    dragMesh,
    freehandMesh,
    computeRenderer,
    photon,
    pathTrace,
    signal,
  } = deps;

  function updateVertexCount() {
    let count = 0;
    for (const mesh of [sigilMesh, draftMesh, dragMesh, freehandMesh]) {
      if (mesh.visible) count += mesh.geometry.getAttribute('position')?.count ?? 0;
    }
    setVertexCount(count);
  }

  function setMeshGeometry(mesh, geometry) {
    const old = mesh.geometry;
    mesh.geometry = geometry;
    old.dispose();
    mesh.visible = (geometry.getAttribute('position')?.count ?? 0) > 0;
    updateVertexCount();
  }

  function clearMesh(mesh) {
    setMeshGeometry(mesh, new THREE.BufferGeometry());
  }

  function stripOptions() {
    const state = getState();
    return {
      ...sparsePreviewOptionsFromState(state),
      pointRadius: true,
      symmetry: 1,
      mirror: false,
      phase: 0,
    };
  }

  function clearCommittedMesh() {
    clearMesh(sigilMesh);
    photon.syncCaster();
    pathTrace.syncSigil();
  }

  function refreshFreehandPreview() {
    const state = getState();
    const strokes = getStrokes();
    const drawing = getDrawing();
    const current = getCurrent();
    if (state.previewStripOnly) {
      const paths = activeBuildPaths(strokes, drawing ? current : [], state);
      if (paths.length === 0) {
        clearMesh(freehandMesh);
        return;
      }
      setMeshGeometry(freehandMesh, buildSparseCurveGeometry(paths, stripOptions()));
      return;
    }

    if (getHoldPreviewUntilRebuild() && !drawing) return;
    if (!drawing || current.length < 2) {
      clearMesh(freehandMesh);
      return;
    }
    setMeshGeometry(
      freehandMesh,
      buildSparseCurveGeometry([current], sparsePreviewOptionsFromState(state)),
    );
  }

  function refreshDraftPreview() {
    const state = getState();
    const draft = getDraft();
    const drag = getDrag();
    if (!draft) {
      clearMesh(draftMesh);
      return;
    }
    const cvs = draft.hover && !drag ? [...draft.cvs, draft.hover] : draft.cvs;
    const cvRadiusScales = draft.hover && !drag
      ? [...draft.cvRadiusScales, clampCvRadiusScale(state.cvRadiusScale)]
      : draft.cvRadiusScales;
    if (cvs.length < 2) {
      clearMesh(draftMesh);
      return;
    }
    const sampled = sampleSplinePoints(cvs, false, cvRadiusScales);
    const paths = expandActivePaths(sampled, state);
    setMeshGeometry(draftMesh, buildSparseCurveGeometry(paths, stripOptions()));
  }

  function refreshDragPreview() {
    const state = getState();
    const strokes = getStrokes();
    if (state.previewStripOnly) {
      clearMesh(dragMesh);
      refreshFreehandPreview();
      return;
    }
    const paths = committedBuildPaths(strokes);
    if (paths.length === 0) {
      clearMesh(dragMesh);
      return;
    }
    setMeshGeometry(dragMesh, buildSparseCurveGeometry(paths, stripOptions()));
  }

  // GPU field and laplacian builds contain readback waits, so UI events can ask
  // for several newer meshes while one is in flight. Keep one active build and
  // at most one trailing build that reads the latest state; obsolete requests
  // are coalesced instead of forming a latency backlog.
  function rebuild() {
    const state = getState();
    const strokes = getStrokes();
    setRebuildVersion(getRebuildVersion() + 1);
    // Empty/strip transitions do not need compute and should remain instant
    // even when an older GPU build is still waiting on readback.
    if (state.previewStripOnly) {
      setRebuildQueued(false);
      clearCommittedMesh();
      clearMesh(dragMesh);
      setHoldPreviewUntilRebuild(false);
      setBlendBackend('strip');
      refreshFreehandPreview();
      return;
    }
    if (strokes.length === 0) {
      setRebuildQueued(false);
      clearMesh(sigilMesh);
      clearMesh(dragMesh);
      setHoldPreviewUntilRebuild(false);
      if (!getDrawing()) clearMesh(freehandMesh);
      setBlendBackend('—');
      photon.syncCaster();
      pathTrace.syncSigil();
      return;
    }
    setRebuildQueued(true);
    if (!getRebuildRunning()) void drainRebuilds();
  }

  async function drainRebuilds() {
    setRebuildRunning(true);
    try {
      while (getRebuildQueued() && !signal.aborted) {
        setRebuildQueued(false);
        const version = getRebuildVersion();
        await runRebuild(version);
      }
    } finally {
      setRebuildRunning(false);
    }
  }

  async function runRebuild(version) {
    const state = getState();
    const strokes = getStrokes();
    try {
      setLastError('');
      if (state.previewStripOnly) {
        clearCommittedMesh();
        clearMesh(dragMesh);
        setHoldPreviewUntilRebuild(false);
        setBlendBackend('strip');
        refreshFreehandPreview();
        return;
      }
      if (strokes.length === 0) {
        clearMesh(sigilMesh);
        clearMesh(dragMesh);
        setHoldPreviewUntilRebuild(false);
        if (!getDrawing()) clearMesh(freehandMesh);
        setBlendBackend('—');
        photon.syncCaster(); // stay armed; hide the caustic while there's no caster
        pathTrace.syncSigil(); // nothing to trace -> drops back to raster
        return;
      }

      const paths = committedBuildPaths(strokes);
      let geometry;
      setBuildingCount(getBuildingCount() + 1);
      try {
        geometry = await buildSigilGeometryAsync(paths, {
          ...buildOptionsForSession(state),
          renderer: getComputeFailed() ? null : computeRenderer,
          onGpuFallback: (error) => {
            setComputeFailed(true);
            console.warn('sigils: compute failed; using the CPU mesh fallback for this session.', error);
          },
        });
      } finally {
        setBuildingCount(getBuildingCount() - 1);
      }

      // signal.aborted: the mode unmounted while this build was in flight —
      // touching the rigs now would resurrect disposed engines into the scene.
      if (version !== getRebuildVersion() || state.previewStripOnly || signal.aborted) {
        geometry.dispose();
        return;
      }

      setBlendBackend(geometry.userData.fieldBackend
        ?? geometry.userData.laplacianBackend
        ?? geometry.userData.buildBackend
        ?? state.backend);

      setMeshGeometry(sigilMesh, geometry);
      // A new committed-CV drag may have started while this build was in
      // flight; keep showing strips until ITS release-rebuild lands.
      const drag = getDrag();
      if (drag?.previewStarted && drag.record !== 'draft') {
        sigilMesh.visible = false;
      } else {
        clearMesh(dragMesh);
      }
      setHoldPreviewUntilRebuild(false);
      if (!getDrawing()) clearMesh(freehandMesh);
      if (pathTrace.active) sigilMesh.visible = false;
      photon.syncCaster();
      pathTrace.syncSigil();
    } catch (error) {
      setLastError(error?.message ?? String(error));
      console.error('sigils rebuild failed', error);
    }
  }

  return {
    setMeshGeometry,
    clearMesh,
    stripOptions,
    clearCommittedMesh,
    refreshFreehandPreview,
    refreshDraftPreview,
    refreshDragPreview,
    updateVertexCount,
    rebuild,
  };
}
