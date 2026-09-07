import type {
  ProjectGenesis,
  ProjectHistoryEvent,
  ProjectTreeNode,
  PrototypeCandidateStatus,
} from "../project-model/contracts.js";

export type WebPrototypeCard = {
  id: string;
  title: string;
  concept: string;
  status: PrototypeCandidateStatus;
  repository: {
    url: string;
    branch: string;
    commitSha: string;
  };
  deployment: {
    url: string;
    provider?: string;
  };
  promotedProjectId?: string;
  createdAt: string;
  updatedAt: string;
};

export type IdeaLabView = {
  prototypes: WebPrototypeCard[];
};

export type WebRunSummary = {
  runId: string;
  objective: string;
  stage: string;
  status: string;
  updatedAt: string;
  policySha256?: string;
  evidenceCount: number;
};

export type ProjectWorkspaceView = {
  project: {
    id: string;
    name: string;
    status: "active" | "archived";
    createdAt: string;
    updatedAt: string;
  };
  genesis: ProjectGenesis;
  tree: ProjectTreeNode[];
  history: ProjectHistoryEvent[];
  runs: WebRunSummary[];
};
