import type { DevelopmentRunRequest } from "../harness/contracts.js";
import { loadProjectWorkspace } from "./workspace-store.js";

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
