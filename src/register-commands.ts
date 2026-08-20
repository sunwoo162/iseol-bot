import { REST, Routes } from "discord.js";
import { contestCommand } from "./commands/contest.js";
import { config } from "./config.js";
import { projectCommand } from "./commands/project.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

await rest.put(
  Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
  {
    body: [projectCommand.toJSON(), contestCommand.toJSON()],
  },
);

console.log("Guild slash command 등록 완료");
