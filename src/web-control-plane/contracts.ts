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

export type WebIdeaLabCampaignSummary = {
  id: string;
  seed: string;
  status: string;
  targetReadyCount: number;
  readyCount: number;
  productionCount: number;
  productionConcurrency: number;
  blockerSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export type WebIdeaLabProductionSummary = {
  id: string;
  campaignId: string;
  proposalId: string;
  runId: string;
  status: string;
  branch: string;
  commitSha?: string;
  deploymentUrl?: string;
  blockerSummary?: string;
  updatedAt: string;
  run?: WebRunSummary;
};

export type IdeaLabView = {
  prototypes: WebPrototypeCard[];
  campaigns: WebIdeaLabCampaignSummary[];
  productions: WebIdeaLabProductionSummary[];
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
