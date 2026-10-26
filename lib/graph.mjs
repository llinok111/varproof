/**
 * Dependency-cycle detection for custom properties.
 *
 * Every `var()` reference inside a definition is an edge, including references
 * that only appear inside a fallback. That is not an approximation: a fallback is
 * only consulted when the referenced property is undefined, so as soon as both
 * ends of a fallback edge *are* defined the browser follows it and the cycle is
 * real. Edge 152 confirms both directions:
 *
 *   --a: var(--b, 10px); --b: var(--a)        -> cycle, --a is invalid  (case c2)
 *   --a: var(--nope, var(--a))                -> cycle, --a is invalid  (case c15)
 *
 * Cycles are reported on the declarations themselves, not on every use site,
 * because the declaration is the single root cause.
 */

/**
 * @param {Map<string, Array<{name: string, refs: Array<{name: string}>}>>} definitions
 * @returns {{cyclic: Set<string>, members: Map<string, string[]>, path: (name: string) => string[]}}
 */
export function findCycles(definitions) {
  const adjacency = new Map();

  for (const [name, list] of definitions) {
    const targets = new Set();

    for (const definition of list) {
      for (const ref of definition.refs) {
        if (definitions.has(ref.name)) {
          targets.add(ref.name);
        }
      }
    }

    adjacency.set(name, targets);
  }

  const members = new Map();

  for (const component of stronglyConnected(adjacency)) {
    const isCycle = component.length > 1 || adjacency.get(component[0])?.has(component[0]);

    if (!isCycle) {
      continue;
    }

    // Every node in a strongly connected component reaches every other node by
    // definition, so the component *is* the member list. An earlier version ran a
    // BFS per pair here, which is O(n^2 * (n + e)) and hung for minutes on a
    // 5,000-node cycle (caught by test/graph.test.mjs).
    for (const name of component) {
      members.set(name, component);
    }
  }

  return {
    cyclic: new Set(members.keys()),
    members,
    path(name) {
      const component = members.get(name);

      if (!component) {
        return [name];
      }

      // Follow edges inside the component until they lead back to `name`. The
      // walk is bounded by the component size; if no such path is found (should
      // not happen inside an SCC) the name is returned alone rather than looping.
      const allowed = new Set(component);
      const walk = [name];
      const seen = new Set([name]);
      let current = name;

      for (let guard = 0; guard < component.length; guard += 1) {
        const edges = adjacency.get(current) ?? [];
        const next = [...edges].find((target) => allowed.has(target) && !seen.has(target));

        if (!next) {
          if (edges.has(name)) {
            walk.push(name);
          }
          break;
        }

        walk.push(next);
        seen.add(next);
        current = next;
      }

      return walk;
    }
  };
}

/** Tarjan, iterative to stay safe on deep graphs. */
function stronglyConnected(adjacency) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  for (const start of adjacency.keys()) {
    if (index.has(start)) {
      continue;
    }

    const work = [{ node: start, edge: 0, edges: [...(adjacency.get(start) ?? [])] }];

    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length) {
      const frame = work[work.length - 1];

      if (frame.edge < frame.edges.length) {
        const next = frame.edges[frame.edge];
        frame.edge += 1;

        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edge: 0, edges: [...(adjacency.get(next) ?? [])] });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
        }
        continue;
      }

      work.pop();

      if (work.length) {
        const parent = work[work.length - 1];
        low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        let node;

        do {
          node = stack.pop();
          onStack.delete(node);
          component.push(node);
        } while (node !== frame.node);

        components.push(component);
      }
    }
  }

  return components;
}
