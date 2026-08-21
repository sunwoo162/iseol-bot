import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import {
  createAllJobFeeds,
  createJobFeed,
  syncJobFeed,
} from "../services/job-feed.js";
import {
  JOB_FIELDS,
  getConfiguredJobSources,
  isJobField,
  jobFieldLabel,
  type JobField,
} from "../services/jobs.js";

export const jobCommand = new SlashCommandBuilder()
  .setName("job")
  .setDescription("개발/IT 취업 공고 자동 수집 공간을 관리합니다.")
  .addSubcommand((subcommand) => subcommand
    .setName("setup")
    .setDescription("전공분야별 취업 공고 채널을 만들고 현재 공고를 가져옵니다.")
    .addStringOption((option) => option
      .setName("field")
      .setDescription("가져올 개발/IT 전공분야")
      .setRequired(true)
      .addChoices(
        { name: "전체 분야", value: "all" },
        { name: "프론트엔드", value: "frontend" },
        { name: "백엔드/서버", value: "backend" },
        { name: "풀스택", value: "fullstack" },
        { name: "앱/모바일", value: "mobile" },
        { name: "AI/데이터", value: "data-ai" },
        { name: "DevOps/클라우드", value: "devops-cloud" },
        { name: "정보보안", value: "security" },
        { name: "임베디드", value: "embedded" },
      )));

async function setupOneField(interaction: ChatInputCommandInteraction, field: JobField): Promise<string> {
  if (!interaction.guild) throw new Error("Discord 서버를 찾을 수 없습니다.");

  const { state, created } = await createJobFeed(interaction.guild, field);
  const added = await syncJobFeed(interaction.client, state);
  return `${created ? "✅" : "ℹ️"} **${jobFieldLabel(field)}** <#${state.channelId}> · ${created ? "채널 생성" : "기존 채널 사용"} · 새 공고 ${added}개`;
}

export async function handleJobCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  if (interaction.options.getSubcommand() !== "setup") return;

  await interaction.deferReply();

  try {
    const sources = getConfiguredJobSources();
    if (sources.length === 0) {
      throw new Error("취업 공고 API 설정이 없습니다. 사람인, 고용24 또는 잡코리아 API 정보를 먼저 설정해주세요.");
    }

    const value = interaction.options.getString("field", true);

    if (value === "all") {
      const feeds = await createAllJobFeeds(interaction.guild);
      const lines: string[] = [];

      for (const { state, created } of feeds) {
        const added = await syncJobFeed(interaction.client, state);
        lines.push(`${created ? "✅" : "ℹ️"} **${jobFieldLabel(state.field)}** <#${state.channelId}> · ${created ? "채널 생성" : "기존 채널 사용"} · 새 공고 ${added}개`);
      }

      await interaction.editReply(
        `💼 개발/IT 취업 공고 채널을 분야별로 준비했습니다.\n출처: **${sources.join(" + ")} 공식 API**\n이후 **1시간마다** 새 공고를 확인합니다.\n\n${lines.join("\n")}`,
      );
      return;
    }

    if (!isJobField(value)) throw new Error("지원하지 않는 전공분야입니다.");
    const result = await setupOneField(interaction, value);

    await interaction.editReply(
      `💼 개발/IT 취업 공고 자동 수집을 설정했습니다.\n출처: **${sources.join(" + ")} 공식 API**\n${result}\n이후 **1시간마다** 새 공고를 확인합니다.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ 취업 공고 자동 수집 설정 실패\n\`${message}\``);
  }
}
