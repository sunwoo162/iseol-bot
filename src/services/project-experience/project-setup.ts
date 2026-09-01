import { parseFigmaFile, type FigmaFileRef } from "../figma.js";
import { parseGitHubRepository, type RepositoryRef } from "../github.js";
import { parseNotionPage, type NotionPageRef } from "../notion.js";
import { findProjectByRepositories } from "../projects.js";

export type RawProjectSetupFields = {
  name: string;
  frontend: string;
  backend: string;
  notion: string;
  figma: string;
};

export type ProjectSetupInput = {
  name: string;
  frontend: RepositoryRef;
  backend: RepositoryRef;
  notion: NotionPageRef | null;
  figma: FigmaFileRef | null;
};

export function parseProjectSetupFields(fields: RawProjectSetupFields): ProjectSetupInput {
  const name = fields.name.trim();
  if (name.length < 2 || name.length > 50) {
    throw new Error("프로젝트 이름은 2~50자로 입력해주세요.");
  }

  const frontend = parseGitHubRepository(fields.frontend.trim());
  const backend = parseGitHubRepository(fields.backend.trim());
  if (frontend.owner.toLowerCase() !== backend.owner.toLowerCase()) {
    throw new Error("Frontend와 Backend 저장소는 같은 GitHub Organization 아래에 있어야 합니다.");
  }

  const notionValue = fields.notion.trim();
  const figmaValue = fields.figma.trim();

  return {
    name,
    frontend,
    backend,
    notion: notionValue ? parseNotionPage(notionValue) : null,
    figma: figmaValue ? parseFigmaFile(figmaValue) : null,
  };
}

export async function assertProjectSetupNotDuplicate(
  guildId: string,
  input: ProjectSetupInput,
): Promise<void> {
  const duplicate = await findProjectByRepositories(guildId, input.frontend, input.backend);
  if (duplicate) {
    throw new Error(`이미 ${duplicate.name} 프로젝트에 같은 GitHub 저장소가 연결되어 있습니다.`);
  }
}
