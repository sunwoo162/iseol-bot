# Iseol ChatGPT Playwright Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production Playwright-backed `ChatGptBrowserDriver` that reuses a dedicated authenticated browser profile, preserves exact ChatGPT conversation identity, extracts one bounded structured result, and fails closed on authentication/UI/session uncertainty.

**Architecture:** Keep the existing `ChatGptBrowserDriver` interface authoritative. Add a narrow Playwright backend module that owns a single persistent context and hides raw Playwright objects, a concrete driver that enforces URL/selector/turn invariants, and a config/resolver that is only selected when explicitly enabled. The existing production adapter, durable ChatGPT Web stores, and Harness remain unchanged owners of schema validation and recovery identity.

**Tech Stack:** TypeScript, Node.js 22+, `playwright-core@1.63.0`, Node test runner, existing ChatGPT Web contracts/errors.

**Spec:** `docs/superpowers/specs/2026-09-08-iseol-chatgpt-playwright-driver-design.md`

## Global Constraints

- Do not persist ChatGPT cookies, access tokens, credentials, prompt bodies, or full assistant payloads in Iseol state/logs.
- Use a dedicated persistent browser profile outside repository/model/run/web roots.
- Never solve or bypass CAPTCHA/MFA/login flows.
- Resume must prove exact `/c/<conversationRef>` identity; never silently replace an existing conversation.
- Selector ambiguity, navigation drift, timeout, or closed browser state must fail closed.`r`n- Structured assistant output is capped at 262,144 UTF-8 bytes; generation completion requires 750 ms of stable final assistant text with no visible stop/generating control.
- Tests must not require a real ChatGPT account; live smoke remains opt-in and external-blocker aware.

---`r`n`r`n

### Task 1: Browser configuration and dependency boundary

**Files:**
- Create: `src/chatgpt-web/playwright-browser-config.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `package.json`, `package-lock.json`
- Test: `tests/chatgpt-web-playwright-config.test.ts`

**Interfaces:**
- Produces: `PlaywrightBrowserDriverConfig` and `resolvePlaywrightBrowserDriverConfig(env, roots)`.
- Produces: `{ enabled: false } | { enabled: true; profileRoot: string; executablePath?: string; headless: boolean }`.

- [ ] **Step 1: Write failing config tests** for disabled defaults, strict booleans, required profile root, and repository/model/run/web root rejection.

```ts
assert.deepEqual(resolvePlaywrightBrowserDriverConfig({}, roots), { enabled: false });
assert.throws(() => resolvePlaywrightBrowserDriverConfig({ ISEOL_CHATGPT_BROWSER_ENABLED: "true" }, roots), /profile/i);
assert.throws(() => resolvePlaywrightBrowserDriverConfig({ ISEOL_CHATGPT_BROWSER_ENABLED: "true", ISEOL_CHATGPT_BROWSER_PROFILE_ROOT: roots.runRoot }, roots), /outside/i);
```

- [ ] **Step 2: Run the new test and verify RED.**

Run: `node --import tsx --test tests/chatgpt-web-playwright-config.test.ts`
Expected: module/function missing.

- [ ] **Step 3: Add exact dependency `playwright-core@1.63.0` and implement strict config resolution.** Use `resolve()`/`relative()` path checks; no credential fields are accepted.

- [ ] **Step 4: Register optional env values in `src/config.ts` and `.env.example`.**

- [ ] **Step 5: Run focused config tests + build, then commit.**

Commit: `feat: configure chatgpt playwright browser`r`n`r`n

### Task 2: Narrow Playwright backend and conversation identity

**Files:**
- Create: `src/chatgpt-web/playwright-browser-backend.ts`
- Create: `src/chatgpt-web/playwright-browser-driver.ts`
- Test: `tests/chatgpt-web-playwright-driver.test.ts`

**Interfaces:**
- Produces backend operations for persistent-context launch, canonical navigation, authenticated composer lookup, URL read, semantic click/fill, assistant text read, generation-state probe, and owned-page close.
- Produces `createPlaywrightChatGptBrowserDriver(config, deps?) : Promise<ChatGptBrowserDriver>`.

- [ ] **Step 1: Write RED tests for new conversation and exact resume.** Fake backend must show that new conversations begin at `https://chatgpt.com/`, resume uses only `https://chatgpt.com/c/<ref>`, and wrong post-navigation refs throw `ChatGptWebSessionLostError`.

```ts
const driver = await createPlaywrightChatGptBrowserDriver(config, { backend });
const opened = await driver.openOrResumeConversation({ prompt: "x", promptSha256: SHA });
assert.equal(opened.conversationRef, "conv-1");
await assert.rejects(() => driver.openOrResumeConversation({ conversationRef: "conv-2", prompt: "x", promptSha256: SHA }), ChatGptWebSessionLostError);
```

- [ ] **Step 2: Run driver tests and verify RED.**

- [ ] **Step 3: Implement canonical ref parsing and authenticated-surface proof.** Login/sign-up surfaces map to `ChatGptWebAuthenticationRequiredError`; ambiguous/missing composer or URL mismatch maps to `ChatGptWebSessionLostError`.

- [ ] **Step 4: Implement the default backend with `playwright-core.chromium.launchPersistentContext`.** The backend exposes no raw `Page`/`BrowserContext` outside its module and never reads cookies.

- [ ] **Step 5: Run focused tests + build, then commit.**

Commit: `feat: open exact chatgpt conversations with playwright`r`n`r`n

### Task 3: One-shot submission, structured extraction, probe, and close

**Files:**
- Modify: `src/chatgpt-web/playwright-browser-driver.ts`
- Modify: `src/chatgpt-web/playwright-browser-backend.ts`
- Test: `tests/chatgpt-web-playwright-driver.test.ts`

**Interfaces:**
- Implements all five `ChatGptBrowserDriver` methods.
- Keeps only in-memory `{ conversationRef, promptSha256, submitted }` turn guards; durable recovery remains outside this driver.

- [ ] **Step 1: Add RED tests** for exact-one submit, URL revalidation before mutation, JSON fence stripping, prose/multiple JSON rejection, bounded output size, generation settle/timeout, probe states, and close isolation.

```ts
await driver.submitPrompt({ conversationRef: "conv-1", prompt: "payload", promptSha256: SHA });
await driver.submitPrompt({ conversationRef: "conv-1", prompt: "payload", promptSha256: SHA });
assert.equal(backend.sendCalls, 1);
assert.deepEqual(await driver.readStructuredResult({ conversationRef: "conv-1", timeoutMs: 1000 }), { version: 1 });
```

- [ ] **Step 2: Verify RED for duplicate-send/result/probe cases.**

- [ ] **Step 3: Implement conservative semantic selectors and turn state.** Never fall back to coordinate clicks or arbitrary text matches.

- [ ] **Step 4: Implement result settling and strict JSON extraction.** Accept one JSON value or one fenced JSON block only; reject surrounding prose, multiple values, malformed JSON, and payloads above 262,144 UTF-8 bytes. Poll generation state at 100 ms and require 750 ms of stable final assistant text before parsing.

- [ ] **Step 5: Implement probe and owned-page close behavior.** Close must not sign out, delete chats, clear profile state, or close unrelated pages.

- [ ] **Step 6: Run focused driver suite + build, then commit.**

Commit: `feat: execute bounded chatgpt browser turns`r`n`r`n

### Task 4: Production resolver and bootstrap wiring

**Files:**
- Modify: `src/chatgpt-web/browser-service.ts`
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Test: `tests/chatgpt-web-browser-service.test.ts`
- Test: `tests/chatgpt-web-playwright-config.test.ts`

**Interfaces:**
- Produces `resolveProductionChatGptBrowserDriver(config, roots, deps?)` returning `null` when disabled and a concrete driver when enabled.
- Existing `startChatGptWebBridgeService(config, driver?)` remains fail-closed and receives only the resolved real driver.

- [ ] **Step 1: Write RED bootstrap tests.** Prove bridge-only enablement still fails without a driver, browser enablement constructs the real driver, unsafe browser config rejects only this capability, and no fake is selected in production.

- [ ] **Step 2: Run focused bootstrap tests and verify RED.**

- [ ] **Step 3: Implement resolver and wire `src/index.ts`.** Build roots from repo/model/run/web configuration; resolve the Playwright driver before starting the bridge and preserve the existing guarded startup behavior so Discord/Web continue if the browser capability is rejected.

- [ ] **Step 4: Run focused browser-service/config tests + build.**

- [ ] **Step 5: Commit.**

Commit: `feat: wire production chatgpt browser driver`

### Task 5: Controlled live smoke and restart/resume proof

**Files:**
- Create: `scripts/chatgpt-web-browser-smoke.ts`
- Modify: `src/chatgpt-web/smoke.ts`
- Modify: `package.json`
- Test: `tests/chatgpt-web-playwright-driver.test.ts`
- Test: `tests/chatgpt-web-browser-service.test.ts`

**Interfaces:**
- `npm run chatgpt:web:smoke` resolves the real driver from env and runs `runChatGptWebControlledSmoke` only when capability is configured.
- Missing profile/browser/auth returns external-blocker exit code `2`; domain failure remains nonzero failure and is never labeled pass.- [ ] **Step 1: Add RED restart/resume test.** Construct driver A, capture `conversationRef`, dispose process-owned state, construct driver B against the same fake persistent backend state, and prove resume targets the same `/c/<ref>` without creating a replacement.

- [ ] **Step 2: Add smoke CLI tests** for disabled/unconfigured capability -> exit `2`, auth-required -> exit `2`, and deterministic fake-driver success through the reusable smoke function.

- [ ] **Step 3: Implement smoke CLI resolver.** It must never auto-login, print credentials/profile contents, or use a fake production driver.

- [ ] **Step 4: Run smoke-focused tests.** Do not run real ChatGPT unless the dedicated profile is already authenticated and explicit browser env is present.

- [ ] **Step 5: Commit.**

Commit: `feat: add chatgpt browser live smoke`

### Task 6: Verification, documentation, and independent review

**Files:**
- Modify: `docs/superpowers/plans/2026-09-08-iseol-chatgpt-web-bridge.md`
- Modify: `docs/superpowers/plans/2026-09-08-iseol-evaluation-hardening.md`
- Modify: this plan with execution evidence

**Interfaces:**
- No new runtime interface; records accurate capability state and blockers.

- [ ] **Step 1: Run focused ChatGPT Web suites.**

Run: `node --import tsx --test tests/chatgpt-web-browser-service.test.ts tests/chatgpt-web-playwright-config.test.ts tests/chatgpt-web-playwright-driver.test.ts tests/chatgpt-web-recovery.test.ts tests/chatgpt-web-e2e.test.ts`
Expected: all pass.

- [ ] **Step 2: Run full repository suite, TypeScript build, and `git diff --check`.**

- [ ] **Step 3: Scan production additions for credential literals, cookie access, unrestricted navigation, coordinate clicks, and profile-path logging.** Expected: zero unsafe production hits.

- [ ] **Step 4: Run controlled live smoke only if explicit browser env exists.** Otherwise record `blocked-external`; never count a fake result as live success.

- [ ] **Step 5: Commit verification docs and request independent Codex review against the branch base.** Fix actionable defects with RED/GREEN regression tests before integration.

Commit: `docs: record chatgpt playwright verification`
