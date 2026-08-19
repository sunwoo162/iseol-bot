import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { config } from "./config.js";
import { handleProjectCommand } from "./commands/project.js";
import { GitHubWebhookService } from "./services/github.js";
import { findProject } from "./services/projects.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const github = new GitHubWebhookService(config.githubToken);

client.once(Events.ClientReady, (readyClient) => console.log(`${readyClient.user.tag} 로그인 완료`));

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "project") await handleProjectCommand(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("project_join:")) {
      const projectId = interaction.customId.split(":")[1];
      const project = projectId ? await findProject(projectId) : null;
      if (!project || project.guildId !== interaction.guildId) {
        await interaction.reply({ content: "프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
        return;
      }

      const username = new TextInputBuilder().setCustomId("github_username").setLabel("GitHub 사용자명").setPlaceholder("예: sunwoo162").setMinLength(1).setMaxLength(39).setRequired(true).setStyle(TextInputStyle.Short);
      const modal = new ModalBuilder().setCustomId(`project_join_modal:${project.id}`).setTitle(`${project.name} 참여`);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(username));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("project_join_modal:")) {
      const projectId = interaction.customId.split(":")[1];
      const project = projectId ? await findProject(projectId) : null;
      if (!project || project.guildId !== interaction.guildId) {
        await interaction.reply({ content: "프로젝트 정보를 찾을 수 없습니다.", ephemeral: true });
        return;
      }

      const username = interaction.fields.getTextInputValue("github_username").trim().replace(/^@/, "");
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
        await interaction.reply({ content: "❌ 올바른 GitHub 사용자명을 입력해주세요.", ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        await github.inviteOrganizationMember(project.organization, username);
        await interaction.editReply(`✅ **@${username}** 계정으로 **${project.organization}** Organization 초대를 보냈습니다.
GitHub 알림 또는 이메일에서 초대를 수락하면 합류가 완료됩니다.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
        await interaction.editReply(`❌ GitHub Organization 초대에 실패했습니다.
\`${message}\`

이미 멤버/초대 대기 중인지, 또는 토큰에 Organization Members 쓰기 권한이 있는지 확인해주세요.`);
      }
    }
  } catch (error) {
    console.error(error);
    if (interaction.isRepliable() && !interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: "명령 처리 중 오류가 발생했습니다.", ephemeral: true }).catch(() => undefined);
    }
  }
});

await client.login(config.discordToken);
