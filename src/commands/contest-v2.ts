import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { handleContestCommand as handleLegacyContestCommand } from "./contest.js";
import {
  createContestAudienceFeed,
  syncContestAudienceFeed,
} from "../services/contest-audience-feed.js";
import {
  contestAudienceFilterLabel,
  type ContestAudienceFilter,
} from "../services/contest-feed.js";

export const contestCommandV2 = new SlashCommandBuilder()
  .setName("contest")
  .setDescription("IT 공모전 자동 수집 공간을 관리합니다.")
  .addSubcommand((subcommand) => subcommand
    .setName("setup")
    .setDescription("공모전 카테고리와 자동 수집 채널을 생성합니다."))
  .addSubcommand((subcommand) => subcommand
    .setName("filter")
    .setDescription("참가대상 전용 새 공모전 채널을 만들고 현재 공모전을 가져옵니다.")
    .addStringOption((option) => option
      .setName("target")
      .setDescription("새 채널에서 모아볼 공모전 참가대상")
      .setRequired(true)
      .addChoices(
        { name: "전체", value: "all" },
        { name: "고등학생", value: "high-school" },
        { name: "대학생", value: "university" },
      )))
  .addSubcommand((subcommand) => subcommand
    .setName("repost")
    .setDescription("테스트용으로 이미 게시한 공모전을 다시 올립니다.")
    .addStringOption((option) => option
      .setName("name")
      .setDescription("다시 올릴 공모전 이름 또는 이름 일부")
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName("my-votes")
    .setDescription("내가 투표한 공모전 목록을 확인합니다."));

function parseAudienceFilter(value: string): ContestAudienceFilter {
  if (value === "all" || value === "high-school" || value === "university") return value;
  throw new Error("지원하지 않는 참가대상 필터입니다.");
}

export async function handleContestCommandV2(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "filter") {
    await handleLegacyContestCommand(interaction);
    return;
  }

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  await interaction.deferReply();

  try {
    const filter = parseAudienceFilter(interaction.options.getString("target", true));
    const { state, created } = await createContestAudienceFeed(interaction.guild, filter);
    const added = await syncContestAudienceFeed(interaction.client, state);
    const label = contestAudienceFilterLabel(filter);

    await interaction.editReply(
      `${created ? "✅" : "ℹ️"} **${label}** 대상 공모전 전용 채널을 ${created ? "만들었습니다" : "이미 사용 중입니다"}.\n` +
      `<#${state.channelId}>에 조건에 맞는 현재 진행 중 IT 공모전을 가져왔습니다. 새로 게시한 공모전: **${added}개**\n` +
      "이후 **1시간마다** 같은 참가대상 조건으로 새 공모전을 확인합니다. 기존 공모전 채널의 필터 설정은 변경하지 않습니다.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await interaction.editReply(`❌ 참가대상별 공모전 채널 생성 실패\n\`${message}\``);
  }
}
