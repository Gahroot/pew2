/**
 * How a task card's Approve / Deny reaches the agent.
 *
 * The voice contract has no "approve" message: approvals are decided either by
 * voice (the model calls a daemon tool, which the app never interprets) or by
 * the existing ACP permission path, `session.permission`, which is what the
 * ordinary approval sheet uses. A card can only use the second, and only when
 * the phone actually holds that permission request (it knows the option ids);
 * otherwise the card says "answer by voice" rather than guessing an id.
 *
 * Risky approvals are never one tap: the UI must confirm first.
 */
import { isDenyApprovalOption, selectApprovalOptions, type ApprovalOption } from "../approvalOptions";
import type { RiskLevel, VoiceTask } from "./types";

export interface HeldPermission {
  sessionId: string;
  requestId: string;
  options: ApprovalOption[];
}

export type CardApproval =
  | {
      kind: "buttons";
      sessionId: string;
      requestId: string;
      approve: ApprovalOption;
      deny: ApprovalOption;
      /** Needs a second, explicit confirmation before approving. */
      confirm: boolean;
      summary: string;
      risk: RiskLevel;
    }
  | { kind: "voice_only"; summary: string; risk: RiskLevel };

const CONFIRM: ReadonlySet<RiskLevel> = new Set(["shell", "merge", "deploy", "destructive"]);

export function needsConfirmation(risk: RiskLevel): boolean {
  return CONFIRM.has(risk);
}

export function cardApproval(task: VoiceTask, held: readonly HeldPermission[]): CardApproval | undefined {
  const approval = task.approval;
  if (!approval) return undefined;
  const base = { summary: approval.summary, risk: approval.risk };
  const match = held.find(
    (h) => h.requestId === approval.requestId && (task.sessionId === undefined || h.sessionId === task.sessionId),
  );
  if (!match) return { kind: "voice_only", ...base };
  const [first, second] = selectApprovalOptions(match.options);
  const deny = [first, second].find((o) => o && isDenyApprovalOption(o));
  const approve = [first, second].find((o) => o && o !== deny);
  if (!approve || !deny) return { kind: "voice_only", ...base };
  return {
    kind: "buttons",
    sessionId: match.sessionId,
    requestId: match.requestId,
    approve,
    deny,
    confirm: needsConfirmation(approval.risk),
    ...base,
  };
}
