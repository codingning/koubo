import fs from "node:fs";

export function loadShotRegistry(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const ids = new Set();
  const shots = (value.shots || []).map(shot => {
    if (!shot.id || ids.has(shot.id)) throw new Error(`镜头注册表 ID 无效或重复：${shot.id || "empty"}`);
    ids.add(shot.id);
    return { ...shot, approved: shot.status === "approved" || shot.status === "promoted" };
  });
  return { schemaVersion: Number(value.schemaVersion || 1), shots };
}

export function selectShot(registry, id, { allowTrial = false } = {}) {
  const shot = registry.shots.find(item => item.id === id);
  if (!shot) throw new Error(`未知镜头：${id}`);
  if (!shot.approved && !allowTrial) throw new Error(`镜头 ${id} 尚未通过 trial 审核`);
  return shot;
}
