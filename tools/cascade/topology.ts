/**
 * The branch graph: the only source of truth for which branch merges which. Planned branches stay in
 * the file with `enabled: false`; they take no part in a run, and an enabled branch may not depend on
 * one.
 */

export interface BranchNode {
  name: string;
  upstreams: string[];
  enabled: boolean;
}

export interface Topology {
  branches: BranchNode[];
}

/** Checks the graph and returns the enabled branches with every upstream before its descendants. */
export function enabledOrder(topology: Topology): BranchNode[] {
  const byName = new Map<string, BranchNode>();
  for (const node of topology.branches) {
    if (byName.has(node.name)) throw new Error(`topology: ${node.name} is listed twice`);
    byName.set(node.name, node);
  }
  for (const node of topology.branches) {
    for (const upstream of node.upstreams) {
      const found = byName.get(upstream);
      if (!found) throw new Error(`topology: ${node.name} merges ${upstream}, which is not listed`);
      if (node.enabled && !found.enabled)
        throw new Error(`topology: enabled ${node.name} merges ${upstream}, which is not enabled`);
    }
  }

  // Kahn's algorithm over all branches, so a cycle through planned branches is reported too; ties
  // keep file order, so runs are reproducible.
  const remaining = new Map(topology.branches.map((node) => [node.name, node.upstreams.length]));
  const ordered: BranchNode[] = [];
  while (remaining.size > 0) {
    const ready = topology.branches.find((node) => remaining.get(node.name) === 0);
    if (!ready) throw new Error(`topology: cycle among ${[...remaining.keys()].join(", ")}`);
    remaining.delete(ready.name);
    ordered.push(ready);
    for (const node of topology.branches) {
      if (remaining.has(node.name)) {
        const count = node.upstreams.filter((upstream) => upstream === ready.name).length;
        remaining.set(node.name, (remaining.get(node.name) ?? 0) - count);
      }
    }
  }
  return ordered.filter((node) => node.enabled);
}
