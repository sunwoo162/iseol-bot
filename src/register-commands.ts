import { REST, Routes } from "discord.js";
import { contestCommandV2 } from "./commands/contest-v2.js";
import { jobCommand } from "./commands/job.js";
import { config } from "./config.js";
import { musicCommand } from "./commands/music.js";
import { projectCommand } from "./commands/project.js";
import { voiceCommand } from "./commands/voice.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

await rest.put(
  Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
  {
    body: [
      projectCommand.toJSON(),
      contestCommandV2.toJSON(),
      jobCommand.toJSON(),
      voiceCommand.toJSON(),
      musicCommand.toJSON(),
    ],
  },
);

console.log("Guild slash command 등록 완료");
