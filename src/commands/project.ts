import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { config } from "../config.js";
import { CalendarStateStore } from "../services/calendar/calendar-state.js";
import { GoogleCalendarService } from "../services/calendar/google-calendar.js";
import { FigmaWebhookService } from "../services/figma.js";
import { GitHubWebhookService } from "../services/github.js";
import { deleteProject, listProjects } from "../services/projects.js";

export const projectCommand = new SlashCommandBuilder()
  .setName("project")
  .setDescription("프로젝트용 Discord 채널과 연동을 자동 관리합니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("한 번의 입력으로 프로젝트 공간과 연동을 자동 설정합니다."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("생성된 프로젝트 방과 연결 정보를 삭제합니다.")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("삭제할 프로젝트 방 선택")
        .setRequired(true)
        .setAutocomplete(true)),
  );

function modalInput(
  id: string,
  label: string,
  placeholder: string,
  required: boolean,
) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setPlaceholder(placeholder)
      .setRequired(required)
      .setStyle(TextInputStyle.Short),
  );
}

async function showProjectSetupModal(interaction: ChatInputCommandInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("project_setup_modal")
    .setTitle("이설 프로젝트 만들기")
    .addComponents(
      modalInput("name", "프로젝트 이름", "예: Rain GJ", true),
      modalInput("frontend", "Frontend GitHub", "https://github.com/org/frontend", true),
      modalInput("backend", "Backend GitHub", "https://github.com/org/backend", true),
      modalInput("notion", "Notion (선택)", "https://www.notion.so/...", false),
      modalInput("figma", "Figma (선택)", "https://www.figma.com/design/...", false),
    );
  await interaction.showModal(modal);
}

export async function handleProjectAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild || interaction.commandName !== "project") return;

  let subcommand: string;
  try {
    subcommand = interaction.options.getSubcommand();
  } catch {
    return;
  }
  if (subcommand !== "delete") return;

  const focused = interaction.options.getFocused().toString().trim().toLowerCase();
  const projects = (await listProjects()).filter((project) => project.guildId === interaction.guild!.id);
  await interaction.respond(
    projects
      .filter((project) => !focused || project.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((project) => ({ name: project.name.slice(0, 100), value: project.categoryId })),
  );
}

async function resolveProjectCategory(interaction: ChatInputCommandInteraction, target: string) {
  if (!interaction.guild) return null;
  const normalizedTarget = target.trim().toLowerCase();
  const projects = (await listProjects()).filter((project) => project.guildId === interaction.guild!.id);
  const project = projects.find((item) =>
    item.categoryId === target || item.name.trim().toLowerCase() === normalizedTarget,
  ) ?? null;
  const channels = await interaction.guild.channels.fetch();
  const selected = project ? channels.get(project.categoryId) : null;
  const category = selected?.type === ChannelType.GuildCategory ? selected : null;
  return { channels, category, project };
}

async function handleDeleteProject(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferReply();
  const target = interaction.options.getString("name", true).trim();

  try {
    const resolved = await resolveProjectCategory(interaction, target);
    const project = resolved?.project;
    const category = resolved?.category;
    const channels = resolved?.channels;
    if (!project || !channels) {
      await interaction.editReply("❌ 이설로 생성한 프로젝트 정보를 찾을 수 없습니다.");
      return;
    }

    const warnings: string[] = [];
    const github = new GitHubWebhookService(config.githubToken);
    const figma = new FigmaWebhookService(
      config.figmaToken,
      config.publicBaseUrl,
      config.figmaWebhookPasscode,
    );

    const githubHooks = [
      [project.frontend, project.frontendHookId, "Frontend GitHub webhook"],
      [project.backend, project.backendHookId, "Backend GitHub webhook"],
      [project.frontend, project.frontendAutomationHookId, "Frontend automation webhook"],
      [project.backend, project.backendAutomationHookId, "Backend automation webhook"],
    ] as const;

    for (const [repository, hookId, label] of githubHooks) {
      if (hookId === undefined) continue;
      try {
        await github.deleteWebhook(repository, hookId);
      } catch (error) {
        console.warn(`${label} 삭제 실패 (${project.name})`, error);
        warnings.push(label);
      }
    }

    if (project.figmaWebhookId) {
      try {
        await figma.deleteWebhook(project.figmaWebhookId);
      } catch (error) {
        console.warn(`Figma 연동 정리 실패 (${project.name})`, error);
        warnings.push("Figma");
      }
    }

    if (project.calendarId) {
      if (config.googleClientId && config.googleClientSecret && config.googleRefreshToken) {
        try {
          await new GoogleCalendarService(
            config.googleClientId,
            config.googleClientSecret,
            config.googleRefreshToken,
            config.googleRedirectUri,
          ).deleteProjectCalendar(project.calendarId);
          await new CalendarStateStore().removeProject(project.id);
        } catch (error) {
          console.warn(`Google Calendar 삭제 실패 (${project.name})`, error);
          warnings.push("Google Calendar");
        }
      } else {
        warnings.push("Google Calendar");
      }
    }

    if (category) {
      const children = channels.filter((channel) => channel?.parentId === category.id);
      for (const channel of children.values()) {
        if (channel) await channel.delete(`${project.name} 프로젝트 방 삭제`);
      }
      await category.delete(`${project.name} 프로젝트 방 삭제`);
    }

    if (!await deleteProject(project.id)) {
      throw new Error("프로젝트 저장 정보를 삭제하지 못했습니다.");
    }
    const warningText = warnings.length
      ? `\n⚠️ 외부 연동 정리 실패: ${warnings.join(", ")} (서버 로그 확인)`
      : "";
    await interaction.editReply(`✅ **${project.name}** 프로젝트 방과 저장 정보를 삭제했습니다.${warningText}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ 프로젝트 방 삭제에 실패했습니다.\n\`${message}\``);
  }
}

export async function handleProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "create") {
    await showProjectSetupModal(interaction);
    return;
  }
  if (subcommand === "delete") {
    await handleDeleteProject(interaction);
  }
}
