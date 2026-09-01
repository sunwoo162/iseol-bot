import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectSettingsId,
  buildProjectSettingsModalId,
  parseProjectIntegrationValue,
  parseProjectSettingsId,
  parseProjectSettingsModalId,
  projectSettingsPanel,
} from "../src/services/project-experience/project-settings.js";
import type { StoredProject } from "../src/services/projects.js";

const project: StoredProject = {
  id: "p1",
  name: "Rain GJ",
  guildId: "guild1",
  categoryId: "category1",
  organization: "rain-gj",
  frontend: { owner: "rain-gj", repo: "frontend", url: "https://github.com/rain-gj/frontend" },
  backend: { owner: "rain-gj", repo: "backend", url: "https://github.com/rain-gj/backend" },
  notionUrl: "https://www.notion.so/0123456789abcdef0123456789abcdef",
  notionPageId: "01234567-89ab-cdef-0123-456789abcdef",
  figmaUrl: "https://www.figma.com/design/abc123/Rain-GJ",
  figmaFileKey: "abc123",
};

test("project integration setting ids round-trip", () => {
  assert.equal(buildProjectSettingsId("notion", "p1"), "project_settings:notion:p1");
  assert.deepEqual(parseProjectSettingsId("project_settings:figma:p1"), { kind: "figma", projectId: "p1" });
  assert.equal(parseProjectSettingsId("project_settings:github:p1"), null);

  assert.equal(buildProjectSettingsModalId("figma", "p1"), "project_settings_modal:figma:p1");
  assert.deepEqual(parseProjectSettingsModalId("project_settings_modal:notion:p1"), { kind: "notion", projectId: "p1" });
  assert.equal(parseProjectSettingsModalId("project_settings_modal:token:p1"), null);
});

test("project integration values validate notion and figma links and allow clearing", () => {
  assert.deepEqual(
    parseProjectIntegrationValue("notion", "https://www.notion.so/0123456789abcdef0123456789abcdef"),
    {
      url: "https://www.notion.so/0123456789abcdef0123456789abcdef",
      notionPageId: "01234567-89ab-cdef-0123-456789abcdef",
    },
  );
  assert.deepEqual(
    parseProjectIntegrationValue("figma", "https://www.figma.com/design/abc123/Rain-GJ"),
    {
      url: "https://www.figma.com/design/abc123/Rain-GJ",
      figmaFileKey: "abc123",
    },
  );
  assert.equal(parseProjectIntegrationValue("notion", "   "), null);
  assert.equal(parseProjectIntegrationValue("figma", ""), null);
  assert.throws(() => parseProjectIntegrationValue("notion", "https://example.com/0123456789abcdef0123456789abcdef"), /Notion/);
  assert.throws(() => parseProjectIntegrationValue("figma", "https://example.com/design/abc123/test"), /Figma/);
});

test("project settings panel only exposes optional link settings", () => {
  const payload = projectSettingsPanel(project);
  const ids = payload.components.flatMap((row) =>
    row.components
      .map((component) => component.data.custom_id)
      .filter((value): value is string => Boolean(value)),
  );
  assert.deepEqual(ids, ["project_settings:notion:p1", "project_settings:figma:p1"]);
  assert.match(payload.embeds[0]?.data.description ?? "", /Notion/);
  assert.match(payload.embeds[0]?.data.description ?? "", /Figma/);
  assert.ok(!/PAT|OAuth|token|secret/i.test(ids.join(" ")));
});
