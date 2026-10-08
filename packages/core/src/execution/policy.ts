import type { PolicyDecision } from "@scaffold/schema/execution";

export interface PolicyRule {
  pattern: string;
  decision: PolicyDecision;
}
const rank: Record<PolicyDecision, number> = { allow: 0, ask: 1, block: 2 };

export function resolveLayer(
  tool: string,
  rules: readonly PolicyRule[],
): PolicyDecision | null {
  let best: PolicyDecision | null = null;
  let specificity = -1;
  for (const rule of rules) {
    const exact = rule.pattern === tool;
    const prefix = rule.pattern.endsWith(".*")
      ? rule.pattern.slice(0, -1)
      : null;
    if (
      !exact &&
      !(
        prefix !== null &&
        tool.startsWith(prefix) &&
        tool.length > prefix.length
      )
    )
      continue;
    const score = exact ? Number.MAX_SAFE_INTEGER : (prefix?.length ?? 0);
    if (
      score > specificity ||
      (score === specificity &&
        best !== null &&
        rank[rule.decision] > rank[best])
    ) {
      best = rule.decision;
      specificity = score;
    }
  }
  return best;
}

/** Workspace Block is mandatory; otherwise profile overrides workspace, with no match Ask. */
export function resolvePolicy(
  tool: string,
  outer: readonly PolicyRule[],
  profile: readonly PolicyRule[],
): PolicyDecision {
  const workspace = resolveLayer(tool, outer);
  if (workspace === "block") return "block";
  return resolveLayer(tool, profile) ?? workspace ?? "ask";
}

/** Same ordering as resolveLayer, evaluated against live rows inside the atomic claim. */
function layerSql(profile: boolean): string {
  return `(SELECT cp.decision FROM control_policies cp WHERE cp.org_id = r.org_id
    AND ${profile ? "cp.profile_id = r.profile_id" : "cp.profile_id IS NULL"}
    AND (cp.pattern = r.tool OR (substr(cp.pattern, -2) = '.*'
      AND substr(r.tool, 1, length(cp.pattern) - 1) = substr(cp.pattern, 1, length(cp.pattern) - 1)
      AND length(r.tool) > length(cp.pattern) - 1))
    ORDER BY (substr(cp.pattern, -2) != '.*') DESC, length(cp.pattern) DESC,
      CASE cp.decision WHEN 'block' THEN 2 WHEN 'ask' THEN 1 ELSE 0 END DESC LIMIT 1)`;
}
export const CURRENT_POLICY_SQL = `(CASE WHEN ${layerSql(false)} = 'block' THEN 'block'
  ELSE coalesce(${layerSql(true)}, ${layerSql(false)}, 'ask') END)`;
