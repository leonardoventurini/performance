// Pure aggregation for the plugin_compile metric — consumes the parsed
// METEOR_PROFILE tree (runner/meteor-profile-parser.js output) and surfaces
// per-compiler-plugin time, per task 21.
//
// Plugin nodes appear in the profile as top-level entries literally named
// "plugin <name>" (verified against a real build — see the parser header):
//   | plugin ecmascript      3 ms (3)
//   | plugin typescript      0 ms (3)
//   | plugin static-html     1 ms (2)
//   | plugin meteor          0 ms (2)
// We filter nodes whose name starts with "plugin ", strip that prefix, and
// group by the bare plugin name. Names are used verbatim (no namespace to
// strip in this format). If a plugin name recurs (multiple profile entries),
// self_ms and count are SUMMED so the map has one stable entry per plugin.
//
// Cardinality is small (4-10 plugins) so there's no top-N truncation — the
// full plugins map is returned, keyed by stable plugin name.
//
// Absence (CC-5): returns null when NO "plugin " nodes are present (the build
// recompiled nothing, or the format changed) so the caller omits the key.

const PLUGIN_PREFIX = 'plugin ';
interface PluginNode { name: string; self_ms?: number; count?: number | null }

export function aggregatePluginCompile(parsed?: { nodes?: readonly PluginNode[] } | null) {
  const nodes = parsed?.nodes;
  if (!Array.isArray(nodes)) return null;

  const plugins: Record<string, { self_ms: number; count: number }> = {};
  let totalPluginMs = 0;
  for (const node of nodes) {
    if (typeof node?.name !== 'string' || !node.name.startsWith(PLUGIN_PREFIX)) continue;
    const name = node.name.slice(PLUGIN_PREFIX.length).trim();
    if (!name) continue;
    const selfMs = Number(node.self_ms ?? 0);
    const count = Number(node.count ?? 0);
    const plugin = plugins[name] ?? { self_ms: 0, count: 0 };
    plugin.self_ms += selfMs;
    plugin.count += count;
    plugins[name] = plugin;
    totalPluginMs += selfMs;
  }

  if (Object.keys(plugins).length === 0) return null;
  return {
    metric: 'plugin_compile',
    total_plugin_ms: totalPluginMs,
    plugins,
  };
}
