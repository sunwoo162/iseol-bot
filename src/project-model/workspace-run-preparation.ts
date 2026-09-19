import type { DevelopmentRunRequest, HarnessRuntimeRunEnvelope } from "../harness/contracts.js";
import { createDevelopmentRun } from "../harness/run-service.js";
import { loadHarnessRun } from "../harness/run-store.js";
import { appendProjectHistoryEventOnce } from "./history-store.js";
import { attachRunToProjectTreeNode } from "./project-tree.js";
import { loadProjectWorkspace, saveProjectWorkspace } from "./workspace-store.js";

export type ProjectExecutionPreparation = {
  projectId: string;
  request: DevelopmentRunRequest;
  plan: {
    purpose: NonNullable<DevelopmentRunRequest["purposeProfile"]>["purpose"];
    executableRoles: NonNullable<DevelopmentRunRequest["purposeProfile"]>["executableRoles"];
    plannedRoles: NonNullable<DevelopmentRunRequest["purposeProfile"]>["plannedRoles"];
    verificationStages: string[];
    documentationRequired: boolean;
  };
};

export type StartProjectWorkspaceRunOptions = {
  iseolRoot: string;
  storeRoot: string;
  policyRoot?: string;
  loadedAt?: string;
};

export type StartProjectWorkspaceRunResult = {
  status: "created" | "already-active";
  run: HarnessRuntimeRunEnvelope;
};

const activeStarts = new Map<string, Promise<StartProjectWorkspaceRunResult>>();

export async function prepareProjectWorkspaceRun(
  root: string,
  projectId: string,
  input: Pick<DevelopmentRunRequest, "runId" | "objective" | "targetRoot">,
): Promise<ProjectExecutionPreparation> {
  const workspace = await loadProjectWorkspace(root, projectId);
  if (!workspace) throw new Error(`Project workspace not found: ${projectId}`);
  const selection = workspace.purposeSelection;
  if (!selection) throw new Error("Project purpose must be selected before run preparation");
  const profile = selection.profile;
  const purposeProfile = {
    version: 1 as const,
    purpose: profile.purpose,
    executableRoles: [...profile.executableRoles],
    plannedRoles: [...profile.plannedRoles],
    verificationStages: [...profile.verificationStages],
    documentationRequired: profile.documentationRequired,
  };
  return {
    projectId,
    request: {
      version: 1,
      mode: "project-workspace",
      runId: input.runId,
      objective: input.objective,
      targetRoot: input.targetRoot,
      projectId,
      purposeProfile,
    },
    plan: {
      purpose: purposeProfile.purpose,
      executableRoles: [...purposeProfile.executableRoles],
      plannedRoles: [...purposeProfile.plannedRoles],
      verificationStages: [...purposeProfile.verificationStages],
      documentationRequired: purposeProfile.documentationRequired,
    },
  };
}

export async function startProjectWorkspaceRun(
  root: string,
  projectId: string,
  input: Pick<DevelopmentRunRequest, "runId" | "objective" | "targetRoot">,
  options: StartProjectWorkspaceRunOptions,
): Promise<StartProjectWorkspaceRunResult> {
  const key = `${options.storeRoot}:${input.runId}`;
  const existingStart = activeStarts.get(key);
  if (existingStart) return existingStart;
  const operation = (async () => {
    const workspace = await loadProjectWorkspace(root, projectId);
    if (!workspace) throw new Error(`Project workspace not found: ${projectId}`);
    const rootNode = workspace.tree.find((node) => node.kind === "root");
    if (!rootNode) throw new Error("Project workspace root node is required before starting a Run");
    const prepared = await prepareProjectWorkspaceRun(root, projectId, input);
    const current = await loadHarnessRun(options.storeRoot, input.runId);
    let run: HarnessRuntimeRunEnvelope;
    let status: "created" | "already-active" = "created";
    if (current) {
      if (current.request.projectId !== projectId || current.request.objective !== prepared.request.objective || current.request.targetRoot !== prepared.request.targetRoot || current.request.purposeProfile?.purpose !== prepared.request.purposeProfile?.purpose) {
        throw new Error("Project Run identity or request does not match the existing Run");
      }
      if (["DONE", "FAILED_FINAL", "CANCELLED"].includes(current.state.status)) {
        throw new Error("Project Run is already terminal");
      }
      run = current;
      status = "already-active";
    } else {
      run = await createDevelopmentRun(prepared.request, {
        iseolRoot: options.iseolRoot,
        storeRoot: options.storeRoot,
        policyRoot: options.policyRoot,
        loadedAt: options.loadedAt,
      });
    }
    const at = options.loadedAt ?? new Date().toISOString();
    const latestWorkspace = await loadProjectWorkspace(root, projectId);
    if (!latestWorkspace) throw new Error(`Project workspace not found: ${projectId}`);
    const attached = attachRunToProjectTreeNode(latestWorkspace, rootNode.id, input.runId, at);
    await saveProjectWorkspace(root, attached);
    await appendProjectHistoryEventOnce(root, {
      version: 1,
      id: `run-attached-${projectId}-${input.runId}`,
      projectId,
      type: "run-attached",
      at,
      summary: `Harness Run attached: ${input.runId}`,
      runId: input.runId,
      nodeId: rootNode.id,
      action: "run-start",
    });
    return { status, run };
  })();
  activeStarts.set(key, operation);
  try { return await operation; }
  finally { if (activeStarts.get(key) === operation) activeStarts.delete(key); }
}
