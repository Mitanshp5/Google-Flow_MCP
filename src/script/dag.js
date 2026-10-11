import { FlowError } from '../utils/errors.js';

/**
 * Builds a semantic story DAG where edges distinguish:
 * - 'reference': entity or scene visual identity requirement
 * - 'continuity': intentional state continuity from another shot
 * - 'panel': storyboard panel requirement
 * - 'take': video take candidate
 * - 'handoff': end-frame / cut continuity
 */
export function buildStoryDag(story) {
  if (!story || typeof story !== 'object') {
    throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] Story is required to build DAG', { story });
  }

  const nodes = new Map();

  const addNode = (id, type, data) => {
    nodes.set(id, {
      id,
      type,
      data,
      incoming: [], // edges pointing into this node (prerequisites)
      outgoing: [], // edges pointing out of this node (dependents)
    });
  };

  const resolveNodeId = (rawId) => {
    if (!rawId || typeof rawId !== 'string') return null;
    const trimmed = rawId.trim();
    if (nodes.has(trimmed)) return trimmed;
    if (nodes.has(`shot:${trimmed}`)) return `shot:${trimmed}`;
    if (nodes.has(`char:${trimmed}`)) return `char:${trimmed}`;
    if (nodes.has(`loc:${trimmed}`)) return `loc:${trimmed}`;
    if (nodes.has(`prop:${trimmed}`)) return `prop:${trimmed}`;
    if (nodes.has(`scene:${trimmed}`)) return `scene:${trimmed}`;
    return null;
  };

  const addEdge = (sourceId, targetId, edgeType) => {
    const resolvedSource = resolveNodeId(sourceId);
    const resolvedTarget = resolveNodeId(targetId);

    if (!resolvedSource) {
      throw new FlowError(
        'DANGLING_DEPENDENCY',
        `[DANGLING_DEPENDENCY] Prerequisite node '${sourceId}' not found for '${targetId}'`,
        { source: sourceId, target: targetId }
      );
    }
    if (!resolvedTarget) {
      throw new FlowError(
        'DANGLING_DEPENDENCY',
        `[DANGLING_DEPENDENCY] Dependent node '${targetId}' not found`,
        { source: sourceId, target: targetId }
      );
    }

    const srcNode = nodes.get(resolvedSource);
    const tgtNode = nodes.get(resolvedTarget);

    const edge = {
      source: resolvedSource,
      target: resolvedTarget,
      prerequisite: resolvedSource,
      dependent: resolvedTarget,
      type: edgeType,
    };
    tgtNode.incoming.push(edge);
    srcNode.outgoing.push(edge);
  };

  // PASS 1: Register all nodes first so forward references can resolve
  // 1. Bible entities
  const bible = story.bible || {};
  for (const c of bible.characters || []) {
    addNode(`char:${c.id}`, 'character', c);
  }
  for (const l of bible.locations || []) {
    addNode(`loc:${l.id}`, 'location', l);
  }
  for (const p of bible.props || []) {
    addNode(`prop:${p.id}`, 'prop', p);
  }

  // 2. Scenes
  for (const sc of story.scenes || []) {
    addNode(`scene:${sc.id}`, 'scene', sc);
  }

  // 3. Shots
  for (const sh of story.shots || []) {
    addNode(`shot:${sh.id}`, 'shot', sh);
  }

  // PASS 2: Wire all edges with dangling reference detection
  for (const sc of story.scenes || []) {
    if (sc.locationId) {
      addEdge(`loc:${sc.locationId}`, `scene:${sc.id}`, 'reference');
    }
  }

  for (const sh of story.shots || []) {
    // Scene reference
    if (sh.sceneId) {
      addEdge(`scene:${sh.sceneId}`, `shot:${sh.id}`, 'reference');
    }

    // Character and prop references
    for (const cid of sh.entities?.characters || []) {
      addEdge(`char:${cid}`, `shot:${sh.id}`, 'reference');
    }
    for (const pid of sh.entities?.props || []) {
      addEdge(`prop:${pid}`, `shot:${sh.id}`, 'reference');
    }

    // Explicit declared dependencies: continuity, reference, panel, take, handoff
    for (const dep of sh.dependencies || []) {
      const rawTarget = typeof dep === 'string' ? dep : dep.target;
      const depType = typeof dep === 'string' ? 'continuity' : (dep.type || 'continuity');
      addEdge(rawTarget, `shot:${sh.id}`, depType);
    }
  }

  const dag = {
    nodes,
    getDependencies: (id) => nodes.get(id)?.incoming || [],
    getDependents: (id) => nodes.get(id)?.outgoing || [],
  };

  // Graph cycle validation
  topologicalSort(dag);

  return dag;
}

/**
 * Performs topological sort using Kahn's algorithm over prerequisite edges.
 * Throws CYCLIC_DEPENDENCY if any directed cycle exists.
 */
export function topologicalSort(dag) {
  if (!dag || !dag.nodes) {
    throw new FlowError('INVALID_DAG', '[INVALID_DAG] Valid DAG object is required', { dag });
  }

  const nodes = dag.nodes;
  const inDegree = new Map();
  const forwardAdj = new Map();

  for (const [id] of nodes) {
    const deps = dag.getDependencies ? dag.getDependencies(id) : (nodes.get(id)?.incoming || []);
    inDegree.set(id, deps.length);
    forwardAdj.set(id, []);
  }

  for (const [id] of nodes) {
    const deps = dag.getDependencies ? dag.getDependencies(id) : (nodes.get(id)?.incoming || []);
    for (const dep of deps) {
      const srcId = dep.prerequisite ?? dep.source ?? dep.target;
      if (forwardAdj.has(srcId)) {
        forwardAdj.get(srcId).push(id);
      }
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  const sorted = [];
  while (queue.length > 0) {
    const curr = queue.shift();
    sorted.push(curr);

    const dependents = forwardAdj.get(curr) || [];
    for (const dep of dependents) {
      if (inDegree.has(dep)) {
        const newDeg = inDegree.get(dep) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) {
          queue.push(dep);
        }
      }
    }
  }

  if (sorted.length < nodes.size) {
    const cyclicNodes = Array.from(nodes.keys()).filter((id) => !sorted.includes(id));
    throw new FlowError(
      'CYCLIC_DEPENDENCY',
      `[CYCLIC_DEPENDENCY] Story dependency graph contains cyclic dependencies involving: ${cyclicNodes.join(', ')}`,
      { cyclicNodes }
    );
  }

  return sorted;
}

/**
 * Computes semantic invalidations based on change classification:
 * - 'metadata': NO downstream invalidations (labels, display name, notes).
 * - 'identity': invalidates node and traverses along all outgoing edge types.
 * - 'continuity': invalidates node and traverses along 'continuity' and 'handoff' edges only.
 * - 'take_selection': invalidates downstream 'handoff' and 'continuity' edges for that shot.
 */
export function computeSemanticInvalidations(dag, changes = []) {
  if (!dag || !dag.nodes) {
    throw new FlowError('INVALID_DAG', '[INVALID_DAG] Valid DAG object is required', { dag });
  }

  // Strength ranking: identity propagates along every edge type and must win
  // over weaker continuity signals arriving via converging paths.
  const STRENGTH = { identity: 3, continuity: 2, take_selection: 2 };
  const strengthOf = (t) => STRENGTH[t] ?? 0;

  const bestType = new Map();
  const queue = [];

  const enqueue = (nodeId, changeType) => {
    if (!changeType || changeType === 'metadata') return;
    if (!dag.nodes.has(nodeId)) return;
    const incoming = strengthOf(changeType);
    if (incoming <= 0) return;
    const curType = bestType.get(nodeId);
    if (curType && strengthOf(curType) >= incoming) return;
    bestType.set(nodeId, changeType);
    queue.push(nodeId);
  };

  for (const change of changes) {
    const { nodeId, changeType = 'identity' } = change;
    enqueue(nodeId, changeType);
  }

  while (queue.length > 0) {
    const currId = queue.shift();
    const effectiveType = bestType.get(currId);
    if (!effectiveType) continue;
    const currNode = dag.nodes.get(currId);
    if (!currNode) continue;

    for (const edge of currNode.outgoing) {
      let shouldPropagate = false;

      if (effectiveType === 'identity') {
        // Identity affects all downstream references, takes, handoffs, and continuity
        shouldPropagate = true;
      } else if (effectiveType === 'continuity' || effectiveType === 'take_selection') {
        // Continuity only propagates along continuity and handoff edges
        shouldPropagate = edge.type === 'continuity' || edge.type === 'handoff';
      }

      if (shouldPropagate) {
        enqueue(edge.target, effectiveType);
      }
    }
  }

  const invalidatedNodeIds = Array.from(bestType.keys());
  const allNodeIds = Array.from(dag.nodes.keys());
  const preservedNodeIds = allNodeIds.filter((id) => !bestType.has(id));

  const affectedShots = invalidatedNodeIds
    .filter((id) => id.startsWith('shot:'))
    .map((id) => id.slice(5));

  const affectedScenes = invalidatedNodeIds
    .filter((id) => id.startsWith('scene:'))
    .map((id) => id.slice(6));

  const affectedEntities = invalidatedNodeIds.filter((id) =>
    id.startsWith('char:') || id.startsWith('loc:') || id.startsWith('prop:')
  );

  return {
    invalidatedNodeIds,
    preservedNodeIds,
    affectedShots,
    affectedScenes,
    affectedEntities,
  };
}

/**
 * Backwards compatibility helper for untyped changes.
 */
export function computeInvalidations(dag, changedNodeIds = []) {
  const changes = changedNodeIds.map((id) => ({ nodeId: id, changeType: 'identity' }));
  return computeSemanticInvalidations(dag, changes);
}
