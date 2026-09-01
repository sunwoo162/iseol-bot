import { ButtonInteraction, PermissionFlagsBits } from "discord.js";
import { config } from "../../config.js";
import { GitHubWebhookService } from "../github.js";
import { findProject } from "../projects.js";
import { ensureProjectReviewWorkflows } from "../review/review-workflow-install.js";
import { parseProjectAdminId, projectAdminPanel } from "./project-admin.js";
import { storedProjectHealth } from "./project-health.js";
import { ensureProjectExperience } from "./project-migration.js";
import { repairProject, type ProjectRepairResult } from "./project-repair.js";

function section(title: string, items: string[]): string | null {
  if (items.length === 0) return null;
  return `**${title}**\n${items.map((item) => `• ${item}`).join("\n")}`;
}

export function formatProjectRepairResult(result: ProjectRepairResult): string {
  return [
    "🔧 **프로젝트 자동 복구 결과**",
    section("복구됨", result.repaired),
    section("변경 없음", result.unchanged),
    section("관리자 설정 필요", result.needsAdmin),
    section("실패", result.failed),
  ].filter((value): value is string => Boolean(value)).join("\n\n");
}

export async function handleProjectAdminButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseProjectAdminId(interaction.customId);
  if (!parsed) return false;

  const project = await findProject(parsed.projectId);
  if (!project || project.guildId !== interaction.guildId) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ content: "권한이 없습니다.", ephemeral: true });
    return true;
  }

  if (parsed.action === "refresh") {
    await interaction.update(projectAdminPanel(project, storedProjectHealth(project)));
    return true;
  }

  if (parsed.action === "settings") {
    await interaction.reply({
      content: [
        `⚙️ **${project.name} 연동 설정**`,
        `Notion · ${project.notionUrl ? "연결됨" : "설정 필요"}`,
        `Figma · ${project.figmaUrl ? "연결됨" : "설정 필요"}`,
        "GitHub PAT/Google OAuth 같은 전역 비밀값은 Discord에서 입력하지 않습니다.",
      ].join("\n"),
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const github = new GitHubWebhookService(config.githubToken);
  const result = await repairProject(project, {
    ensureExperience: (target) => ensureProjectExperience(interaction.client, target),
    ensureReviewWorkflows: (target) => ensureProjectReviewWorkflows(github, target),
  });

  await interaction.editReply(formatProjectRepairResult(result));
  return true;
}
