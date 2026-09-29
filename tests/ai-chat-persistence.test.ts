import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createMemoryService } from "../src/memory/service.js";
import { createAiChatService } from "../src/ai-chat/service.js";

const principal = (userId: string): Principal => ({ userId, sessionId: `${userId}-session`, roles: ["user"] });
test("AI conversations and waiting Runtime messages persist per user and append private memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-ai-chat-"));
  const memory = createMemoryService(root, { now: () => "2026-09-26T12:00:00.000Z" });
  const chat = createAiChatService(root, { memoryService: memory, now: () => "2026-09-26T12:00:00.000Z" });
  const a = principal("ai-chat-a"); const b = principal("ai-chat-b");
  const conversation = await chat.createConversation(a, "학습 대화");
  const sent = await chat.sendMessage(a, conversation.id, "TypeScript 제네릭을 예제로 설명해줘");
  assert.equal(sent.runtimeStatus, "waiting_runtime");
  assert.equal(sent.conversation.messages[0].status, "waiting_runtime");
  const restarted = createAiChatService(root, { memoryService: memory, now: () => "2026-09-26T12:00:00.000Z" });
  assert.equal((await restarted.getConversation(a, conversation.id))?.messages.length, 1);
  assert.equal((await memory.listPrivateMemories(a, {})).length, 1);
  assert.equal((await restarted.getConversation(b, conversation.id)), null);
});

test("AI conversation mutations across service instances preserve both messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-ai-chat-cross-service-mutation-"));
  const owner = principal("ai-chat-cross-service-owner");
  const firstService = createAiChatService(root, { now: () => "2026-09-28T12:00:00.000Z" });
  const secondService = createAiChatService(root, { now: () => "2026-09-28T12:00:00.000Z" });
  const conversation = await firstService.createConversation(owner, "교차 서비스 대화");

  await Promise.all([
    firstService.sendMessage(owner, conversation.id, "첫 번째 서비스 메시지"),
    secondService.sendMessage(owner, conversation.id, "두 번째 서비스 메시지"),
  ]);

  const persisted = await createAiChatService(root).getConversation(owner, conversation.id);
  assert.deepEqual(persisted?.messages.map((message) => message.content).sort(), ["두 번째 서비스 메시지", "첫 번째 서비스 메시지"].sort());
});
