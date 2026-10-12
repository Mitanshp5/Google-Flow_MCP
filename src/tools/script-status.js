import { getScriptStatus } from '../script/planner.js';
import { listCandidateJobs } from '../script/candidate-jobs.js';
import { listCandidates, getCandidate } from '../script/candidate-store.js';
import { listScores, listReferences, checkReferenceFreshness, computeSemanticNodeDigest } from '../script/reference-review.js';
import { getStory } from '../script/store.js';
import { buildStoryDag } from '../script/dag.js';
import { FlowError } from '../utils/errors.js';

function isReferenceStale(ref, snapshot, dag, { root } = {}) {
  // Shared freshness helper (never separate prompt-only logic). Storage
  // corruption/future-version/containment propagate (fail closed); only
  // missing/tampered media and semantic/binding changes report stale.
  // Candidate record reads go through the accepted contained reader first so a
  // planted outside path or corrupt record fails closed instead of hiding.
  try {
    getCandidate(ref.scriptId, ref.candidateId, { root });
  } catch (e) {
    if (e instanceof FlowError && (e.code === 'STORAGE_CORRUPT' || e.code === 'STORAGE_VERSION_UNSUPPORTED' || e.code === 'INVALID_STORY_ID')) throw e;
    return true;
  }
  let result;
  try {
    result = checkReferenceFreshness(ref, snapshot, dag, { root });
  } catch (e) {
    if (e instanceof FlowError && (e.code === 'STORAGE_CORRUPT' || e.code === 'STORAGE_VERSION_UNSUPPORTED' || e.code === 'INVALID_STORY_ID')) throw e;
    return true;
  }
  return !result.current;
}

export async function handleScriptStatus(args) {
  const status = getScriptStatus(args);
  const scriptId = args?.scriptId ?? args?.storyId ?? status.scriptId;
  const now = Date.now();
  const candidateJobs = listCandidateJobs(scriptId).map(j => ({
    jobId: j.jobId, stage: j.stage, nodeId: j.nodeId,
    quantity: j.quantity, reserved: j.reserved, candidateLimit: j.candidateLimit,
    timeBudgetSec: j.timeBudgetSec, scriptRevision: j.scriptRevision, policyRevision: j.policyRevision,
    createdAt: j.createdAt, deadlineAt: j.deadlineAt, deadlineAtMs: j.deadlineAtMs,
    elapsedMs: Math.max(0, now - j.createdAtMs),
    elapsedSec: Math.max(0, now - j.createdAtMs) / 1000,
    exhausted: now > j.deadlineAtMs,
    status: j.status, invocation: j.invocation, canSpend: false, liveVerified: false,
    nextAction: j.nextAction,
  }));
  // Immutable local candidates: full UUIDs/digests, never Flow-labelled.
  // Fail-closed: corrupt candidate records propagate (no empty success).
  let candidates = [];
  try {
    candidates = listCandidates(scriptId).map(c => ({
      candidateId: c.candidateId, jobId: c.jobId, nodeId: c.nodeId, nodeDigest: c.nodeDigest,
      scriptRevision: c.scriptRevision, hash: c.hash, sourceHash: c.sourceHash, exportHash: c.exportHash,
      path: c.path, size: c.size, mime: c.mime, ext: c.ext, width: c.width, height: c.height,
      sourceKind: c.sourceKind, provenance: c.provenance, rights: c.rights,
      ...(c.rightsNote !== undefined ? { rightsNote: c.rightsNote } : {}),
      variantIndex: c.variantIndex, duplicateOf: c.duplicateOf,
      model: c.model, ratio: c.ratio, createdAt: c.createdAt, canSpend: false, liveVerified: false,
    }));
  } catch (e) {
    // Preserve W08 fields but surface candidate corruption instead of hiding it.
    // Re-throw so status fails closed like jobs do.
    throw e;
  }
  // Manual review + canonical references: current vs historical vs stale, never from
  // W08 text approval alone. Fail-closed on corruption like jobs/candidates.
  // Selective invalidation: bible identity/prompt changes stale only affected
  // refs/packs + continuity successors via accepted DAG; independent stay current.
  // Display-only edits (prompt unchanged) do not stale compatible references.
  let scores = [];
  let referencesCurrent = [];
  let referencesStale = [];
  let referencesHistory = [];
  let snapshotForPacks = null;
  let dagForPacks = null;
  try {
    scores = listScores(scriptId).map(s => ({
      scoreId: s.scoreId, candidateId: s.candidateId, candidateHash: s.candidateHash,
      nodeId: s.nodeId, nodeDigest: s.nodeDigest, scriptRevision: s.scriptRevision,
      reviewer: s.reviewer, reason: s.reason, gates: s.gates, ratings: s.ratings,
      confidences: s.confidences, rubricVersion: s.rubricVersion, weights: s.weights,
      applicableWeights: s.applicableWeights, score: s.score, eligible: s.eligible,
      status: s.status, createdAt: s.createdAt, canSpend: false, liveVerified: false,
    }));
    snapshotForPacks = getStory(scriptId);
    try {
      dagForPacks = buildStoryDag(snapshotForPacks);
    } catch {
      dagForPacks = null;
    }
    const allRefs = listReferences(scriptId);
    referencesHistory = allRefs.map(r => ({
      referenceId: r.referenceId, nodeId: r.nodeId, nodeDigest: r.nodeDigest,
      candidateId: r.candidateId, candidateHash: r.candidateHash, hash: r.candidateHash,
      scriptRevision: r.scriptRevision, selectionRevision: r.selectionRevision,
      reviewer: r.reviewer, reason: r.reason, status: r.status,
      createdAt: r.createdAt, canSpend: false, liveVerified: false,
    }));
    const maxByNode = new Map();
    for (const r of allRefs) {
      const cur = maxByNode.get(r.nodeId);
      if (!cur || r.selectionRevision > cur.selectionRevision) maxByNode.set(r.nodeId, r);
    }
    for (const [, r] of maxByNode) {
      const stale = isReferenceStale(r, snapshotForPacks, dagForPacks, { root: undefined });
      // isReferenceStale uses getCandidate with default root (FLOW_HOME);
      // scriptId scope ensures correct root via env. For explicit root isolation
      // in tests, FLOW_HOME is set, so default root is correct.
      const mapped = {
        referenceId: r.referenceId, nodeId: r.nodeId, nodeDigest: r.nodeDigest,
        candidateId: r.candidateId, candidateHash: r.candidateHash, hash: r.candidateHash,
        scriptRevision: r.scriptRevision, selectionRevision: r.selectionRevision,
        reviewer: r.reviewer, reason: r.reason, status: stale ? 'stale' : 'current',
        createdAt: r.createdAt, canSpend: false, liveVerified: false,
      };
      if (stale) referencesStale.push(mapped);
      else referencesCurrent.push(mapped);
    }
    referencesCurrent.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    referencesStale.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  } catch (e) {
    throw e;
  }
  // Packs: versioned immutable history with selective staleness.
  // No permissive catch: corrupt pack JSON / shapes / containment propagate
  // (fail closed), never hidden as empty success.
  let packsCurrent = [];
  let packsStale = [];
  let packsHistory = [];
  {
    const mod = await import('../script/reference-review.js');
    {
      const allPacks = mod.listPacks(scriptId);
      packsHistory = allPacks.map(p => ({
        packId: p.packId, shotId: p.shotId, shotDigest: p.shotDigest,
        scriptRevision: p.scriptRevision, packRevision: p.packRevision,
        selections: p.selections, reviewer: p.reviewer, reason: p.reason,
        status: p.status, createdAt: p.createdAt, canSpend: false, liveVerified: false,
      }));
      const maxByShot = new Map();
      for (const p of allPacks) {
        const cur = maxByShot.get(p.shotId);
        if (!cur || p.packRevision > cur.packRevision) maxByShot.set(p.shotId, p);
      }
      // Freshness recomputes the exact required entity set from the owning
      // scene + actual shot/DAG, current semantic shot/state context and
      // canonical selection versions/hashes. Over-cap blocks with no omission.
      const staleShots = new Set();
      const currentRefByNode = new Map();
      for (const r of referencesCurrent) currentRefByNode.set(r.nodeId, r);
      const staleRefNodes = new Set(referencesStale.map((r) => r.nodeId));
      const requiredSetFor = (shotId) => {
        const rawId = shotId.startsWith('shot:') ? shotId.slice(5) : shotId;
        const shot = (snapshotForPacks.shots || []).find((s) => s.id === rawId);
        if (!shot) return null;
        const scene = (snapshotForPacks.scenes || []).find((sc) => sc.id === shot.sceneId);
        if (!scene) return null;
        const req = new Set();
        for (const cid of shot.entities?.characters || []) req.add(`char:${cid}`);
        for (const pid of shot.entities?.props || []) req.add(`prop:${pid}`);
        if (scene.locationId) req.add(`loc:${scene.locationId}`);
        try {
          if (dagForPacks) {
            for (const dep of dagForPacks.getDependencies(shotId)) {
              const src = dep.prerequisite ?? dep.source;
              if (typeof src === 'string' && /^(char|loc|prop):/.test(src) && dep.type === 'reference') req.add(src);
            }
          }
        } catch { /* DAG validated above */ }
        return [...req].sort();
      };
      for (const [, pack] of maxByShot) {
        let stale = false;
        const required = requiredSetFor(pack.shotId);
        if (!required) {
          stale = true;
        } else if (required.length !== (pack.selections || []).length || JSON.stringify(required) !== JSON.stringify((pack.selections || []).map((s) => s.nodeId).sort())) {
          // Required entity set changed (e.g. owning scene location change).
          stale = true;
        } else {
          // Current semantic shot context must still match (display-only shot
          // edits preserve; semantic/state changes stale).
          const shotSemanticNow = computeSemanticNodeDigest(snapshotForPacks, pack.shotId);
          let shotSemanticThen = null;
          try {
            if (pack.scriptRevisionId) {
              const hist = getStory(scriptId, { revisionId: pack.scriptRevisionId });
              shotSemanticThen = computeSemanticNodeDigest(hist, pack.shotId);
            }
          } catch { shotSemanticThen = null; }
          if (shotSemanticNow && shotSemanticThen ? shotSemanticNow !== shotSemanticThen : (snapshotForPacks?.nodeStates?.[pack.shotId]?.nodeDigest !== pack.shotDigest)) {
            stale = true;
          } else {
            for (const sel of pack.selections || []) {
              const curRef = currentRefByNode.get(sel.nodeId);
              if (!curRef || curRef.referenceId !== sel.referenceId || curRef.selectionRevision !== sel.selectionRevision || String(curRef.candidateHash).toLowerCase() !== String(sel.hash).toLowerCase()) {
                stale = true;
                break;
              }
              if (staleRefNodes.has(sel.nodeId)) {
                stale = true;
                break;
              }
            }
          }
        }
        if (stale) staleShots.add(pack.shotId);
      }
      // Propagate via accepted DAG continuity/handoff successors (not entire film).
      if (dagForPacks) {
        const queue = [...staleShots];
        const seen = new Set(queue);
        while (queue.length > 0) {
          const cur = queue.shift();
          const node = dagForPacks.nodes.get(cur);
          if (!node) continue;
          for (const edge of node.outgoing || []) {
            if (edge.type === 'continuity' || edge.type === 'handoff') {
              const tgt = edge.target;
              if (tgt.startsWith('shot:') && !seen.has(tgt)) {
                seen.add(tgt);
                staleShots.add(tgt);
                queue.push(tgt);
              }
            }
          }
        }
      }
      for (const [, pack] of maxByShot) {
        const mapped = {
          packId: pack.packId, shotId: pack.shotId, shotDigest: pack.shotDigest,
          scriptRevision: pack.scriptRevision, packRevision: pack.packRevision,
          selections: pack.selections, reviewer: pack.reviewer, reason: pack.reason,
          status: staleShots.has(pack.shotId) ? 'stale' : 'current',
          createdAt: pack.createdAt, canSpend: false, liveVerified: false,
        };
        if (staleShots.has(pack.shotId)) packsStale.push(mapped);
        else packsCurrent.push(mapped);
      }
      packsCurrent.sort((a, b) => a.shotId.localeCompare(b.shotId));
      packsStale.sort((a, b) => a.shotId.localeCompare(b.shotId));
    }
  }
  return {
    ...status,
    candidateJobs,
    candidates,
    scores,
    reviews: scores,
    references: { current: referencesCurrent, stale: referencesStale, history: referencesHistory },
    packs: { current: packsCurrent, stale: packsStale, history: packsHistory },
    canSpend: false,
    liveVerified: false,
  };
}

export const handleStoryStatus = handleScriptStatus;
