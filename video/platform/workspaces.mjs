const WORKSPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeWorkspaceId(value, fallback = "local-default") {
  const normalized = String(value || "").trim().toLowerCase();
  if (WORKSPACE_PATTERN.test(normalized)) return normalized;
  return fallback;
}

export function workspaceIdFromRequest(req, fallback = "local-default") {
  return normalizeWorkspaceId(req?.headers?.["x-koubo-workspace"], fallback);
}

export function bindWorkspace(record, workspaceId) {
  return { ...record, workspaceId: normalizeWorkspaceId(workspaceId) };
}

export function belongsToWorkspace(record, workspaceId) {
  const expected = normalizeWorkspaceId(workspaceId);
  return normalizeWorkspaceId(record?.workspaceId, "local-default") === expected;
}

export function assertWorkspaceAccess(record, workspaceId) {
  if (belongsToWorkspace(record, workspaceId)) return record;
  const error = new Error("当前工作区无权访问该记录");
  error.statusCode = 404;
  error.code = "WORKSPACE_RECORD_NOT_FOUND";
  throw error;
}
