import fs from "node:fs";

export function loadPluginRegistry(file, env = process.env) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const plugins = Object.fromEntries(Object.entries(parsed.plugins || {}).map(([id, spec]) => {
    const enabledByEnv = ["1", "true", "yes"].includes(String(env[spec.enableEnv] || "").toLowerCase());
    return [id, { ...spec, id, enabled: spec.enabled === true || enabledByEnv }];
  }));
  return { schemaVersion: Number(parsed.schemaVersion || 1), plugins };
}

export function pluginStatus(registry) {
  return Object.values(registry.plugins || {}).map(plugin => ({
    id: plugin.id,
    enabled: plugin.enabled === true,
    tier: plugin.tier,
    privacy: plugin.privacy,
    cost: plugin.cost,
    reason: plugin.enabled ? "explicitly-enabled" : "disabled-by-default",
  }));
}
