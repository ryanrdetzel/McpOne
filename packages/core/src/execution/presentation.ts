import {
  EXECUTION_FALLBACK_PREFIX,
  EXECUTION_META_NAMESPACE,
  RunControl,
} from "@scaffold/schema/execution";
import type { RunView } from "./service";

/** One presentation contract for pre-terminal response bounds and the inbound MCP renderer. */
export function toolResult(run: RunView) {
  const provenance = {
    run_id: run.runId,
    tool: run.tool,
    ...(run.accounts && Object.keys(run.accounts).length
      ? { accounts: run.accounts }
      : {}),
  };
  const control = RunControl.parse({
    ...provenance,
    status: run.status,
    ...(run.approvalLink ? { approval_url: run.approvalLink } : {}),
    ...(run.error ? { error: run.error } : {}),
  });
  const business = run.businessResult;
  const content = business ? [...business.content] : [];
  content.push({
    type: "text" as const,
    text: EXECUTION_FALLBACK_PREFIX + JSON.stringify(control),
  });
  return {
    content,
    ...(business?.structuredContent !== undefined
      ? { structuredContent: business.structuredContent }
      : {}),
    isError:
      business?.isError === true ||
      Boolean(run.error) ||
      [
        "denied",
        "blocked",
        "expired",
        "canceled",
        "failed",
        "outcome_unknown",
      ].includes(run.status),
    _meta: { ...business?._meta, [EXECUTION_META_NAMESPACE]: provenance },
  };
}
