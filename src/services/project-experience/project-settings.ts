import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { parseFigmaFile } from "../figma.js";
import { parseNotionPage } from "../notion.js";
import { findProject, updateProject, type StoredProject } from "../projects.js";

export type ProjectSettingKind = "notion" | "figma";

export type ProjectIntegrationValue =
  | { url: string; notionPageId: string }
  | { url: string; figmaFileKey: string };

export function buildProjectSettingsId(kind: ProjectSettingKind, projectId: string): string {
  return `project_settings:${kind}:${projectId}`;
}

export function parseProjectSettingsId(customId: string): {
  kind: ProjectSettingKind;
  projectId: string;
} | null {
  const match = /^project_settings:(notion|figma):([A-Za-z0-9_-]+)$/.exec(customId);
  return match
    ? { kind: match[1] as ProjectSettingKind, projectId: match[2]! }
    : null;
}

export function buildProjectSettingsModalId(kind: ProjectSettingKind, projectId: string): string {
  return `project_settings_modal:${kind}:${projectId}`;
}

export function parseProjectSettingsModalId(customId: string): {
  kind: ProjectSettingKind;
  projectId: string;
} | null {
  const match = /^project_settings_modal:(notion|figma):([A-Za-z0-9_-]+)$/.exec(customId);
  return match
    ? { kind: match[1] as ProjectSettingKind, projectId: match[2]! }
    : null;
}

export function parseProjectIntegrationValue(
  kind: ProjectSettingKind,
  value: string,
): ProjectIntegrationValue | null {
  const input = value.trim();
  if (!input) return null;

  if (kind === "notion") {
    const notion = parseNotionPage(input);
    return { url: notion.url, notionPageId: notion.id };
  }

  const figma = parseFigmaFile(input);
  return { url: figma.url, figmaFileKey: figma.key };
}

export function projectSettingsPanel(project: StoredProject) {
  const description = [
    `📄 Notion · ${project.notionUrl ? "연결됨" : "설정 필요"}`,
    `🎨 Figma · ${project.figmaUrl ? "연결됨" : "설정 필요"}`,
    "",
    "링크만 관리합니다. GitHub PAT, Google OAuth, Discord secret 같은 전역 비밀값은 여기서 입력하지 않습니다.",
    "입력값을 비우고 저장하면 해당 선택 연동을 해제합니다.",
  ].join("\n");

  return {
    embeds: [new EmbedBuilder()
      .setTitle(`⚙️ ${project.name} 연동 설정`)
      .setDescription(description)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildProjectSettingsId("notion", project.id))
          .setLabel("Notion 설정")
          .setEmoji("📄")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildProjectSettingsId("figma", project.id))
          .setLabel("Figma 설정")
          .setEmoji("🎨")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    ephemeral: true as const,
  };
}

function settingsModal(project: StoredProject, kind: ProjectSettingKind): ModalBuilder {
  const isNotion = kind === "notion";
  const current = isNotion ? project.notionUrl : project.figmaUrl;
  const input = new TextInputBuilder()
    .setCustomId("url")
    .setLabel(isNotion ? "Notion 페이지 링크" : "Figma 파일 링크")
    .setPlaceholder(isNotion
      ? "https://www.notion.so/..."
      : "https://www.figma.com/design/...")
    .setRequired(false)
    .setStyle(TextInputStyle.Short);
  if (current) input.setValue(current.slice(0, 4000));

  return new ModalBuilder()
    .setCustomId(buildProjectSettingsModalId(kind, project.id))
    .setTitle(isNotion ? "Notion 연동 설정" : "Figma 연동 설정")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

async function resolveManagedProject(
  projectId: string,
  guildId: string | null,
): Promise<StoredProject | null> {
  if (!guildId) return null;
  const project = await findProject(projectId);
  return project?.guildId === guildId ? project : null;
}

export async function handleProjectSettingsButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseProjectSettingsId(interaction.customId);
  if (!parsed) return false;

  const project = await resolveManagedProject(parsed.projectId, interaction.guildId);
  if (!project) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ content: "권한이 없습니다.", ephemeral: true });
    return true;
  }

  await interaction.showModal(settingsModal(project, parsed.kind));
  return true;
}

export async function handleProjectSettingsModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const parsed = parseProjectSettingsModalId(interaction.customId);
  if (!parsed) return false;

  const project = await resolveManagedProject(parsed.projectId, interaction.guildId);
  if (!project) {
    await interaction.reply({ content: "연결 정보를 찾을 수 없습니다.", ephemeral: true });
    return true;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ content: "권한이 없습니다.", ephemeral: true });
    return true;
  }

  let value: ProjectIntegrationValue | null;
  try {
    value = parseProjectIntegrationValue(parsed.kind, interaction.fields.getTextInputValue("url"));
  } catch (error) {
    await interaction.reply({
      content: `❌ ${error instanceof Error ? error.message : "올바른 링크를 입력해주세요."}`,
      ephemeral: true,
    });
    return true;
  }

  if (parsed.kind === "notion") {
    const notion = value && "notionPageId" in value ? value : null;
    await updateProject(project.id, {
      notionUrl: notion?.url,
      notionPageId: notion?.notionPageId,
      notionLastEditedTime: undefined,
    });
  } else {
    const figma = value && "figmaFileKey" in value ? value : null;
    await updateProject(project.id, {
      figmaUrl: figma?.url,
      figmaFileKey: figma?.figmaFileKey,
      figmaWebhookId: undefined,
      figmaLastVersionId: undefined,
      figmaKnownCommentIds: undefined,
    });
  }

  const serviceName = parsed.kind === "notion" ? "Notion" : "Figma";
  await interaction.reply({
    content: value
      ? `✅ ${serviceName} 링크를 저장했습니다. 프로젝트 상태를 새로고침하면 반영된 상태를 확인할 수 있습니다.`
      : `✅ ${serviceName} 선택 연동을 해제했습니다.`,
    ephemeral: true,
  });
  return true;
}
