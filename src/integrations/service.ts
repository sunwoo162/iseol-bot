import { createHash } from "node:crypto";
import { assertIdentityId, assertTimestamp, type Principal } from "../identity/contracts.js";
import { INTEGRATION_PROVIDERS, type IntegrationAdapter, type IntegrationDelivery, type IntegrationDeliveryInput, type IntegrationProvider, type IntegrationService } from "./contracts.js";
import { listIntegrationDeliveries, loadIntegrationDelivery, saveIntegrationDelivery } from "./store.js";

type IntegrationServiceOptions = {
  now?: () => string;
  adapters?: Partial<Record<IntegrationProvider, IntegrationAdapter>>;
  isOptedIn?: (userId: string, provider: IntegrationProvider) => boolean | Promise<boolean>;
};

function ensurePrincipal(principal: Principal): void { assertIdentityId(principal.userId); }

function validateInput(input: IntegrationDeliveryInput): void {
  if (!INTEGRATION_PROVIDERS.includes(input.provider)) throw new Error("Invalid integration provider");
  for (const [label, value] of [["sourceType", input.sourceType], ["sourceId", input.sourceId], ["eventType", input.eventType]] as const) {
    if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid integration ${label}`);
  }
  if (!Number.isInteger(input.eventVersion) || input.eventVersion < 1 || input.eventVersion > 1000) throw new Error("Invalid integration event version");
  const payload = input.payload ?? {};
  if (typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length > 24) throw new Error("Invalid integration payload");
  for (const [key, value] of Object.entries(payload)) {
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(key) || (typeof value === "string" && value.length > 1000) || (value !== null && !["string", "number", "boolean"].includes(typeof value))) {
      throw new Error("Invalid integration payload");
    }
  }
}

function identity(userId: string, input: IntegrationDeliveryInput): string {
  return createHash("sha256").update([userId, input.provider, input.sourceType, input.sourceId, input.eventType, input.eventVersion].join("\u001f")).digest("hex").slice(0, 40);
}

function sameInput(current: IntegrationDelivery, input: IntegrationDeliveryInput): boolean {
  return current.provider === input.provider
    && current.sourceType === input.sourceType
    && current.sourceId === input.sourceId
    && current.eventType === input.eventType
    && current.eventVersion === input.eventVersion
    && JSON.stringify(current.payload) === JSON.stringify(input.payload ?? {});
}

export function createIntegrationService(root: string, options: IntegrationServiceOptions = {}): IntegrationService {
  const now = options.now ?? (() => new Date().toISOString());
  const adapters = options.adapters ?? {};
  const isOptedIn = options.isOptedIn ?? (() => false);

  return {
    async enqueueDelivery(principal, input) {
      ensurePrincipal(principal);
      validateInput(input);
      const at = now();
      assertTimestamp(at, "integration delivery timestamp");
      const id = `integration-delivery-${identity(principal.userId, input)}`;
      const existing = await loadIntegrationDelivery(root, principal.userId, id);
      if (existing) {
        if (!sameInput(existing, input)) throw new Error("Delivery identity conflict");
        return existing;
      }
      const delivery: IntegrationDelivery = {
        version: 1,
        id,
        userId: principal.userId,
        provider: input.provider,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        payload: { ...(input.payload ?? {}) },
        state: "queued",
        attempts: 0,
        createdAt: at,
        updatedAt: at,
      };
      await saveIntegrationDelivery(root, delivery);
      return delivery;
    },

    async dispatchDelivery(principal, deliveryId) {
      ensurePrincipal(principal);
      assertIdentityId(deliveryId);
      const current = await loadIntegrationDelivery(root, principal.userId, deliveryId);
      if (!current || current.userId !== principal.userId) throw new Error("Delivery not found");
      if (current.state !== "queued") return current;
      const at = now();
      assertTimestamp(at, "integration delivery timestamp");
      if (!await isOptedIn(principal.userId, current.provider)) {
        const blocked: IntegrationDelivery = { ...current, state: "blocked", reason: "user-opt-in-required", updatedAt: at };
        await saveIntegrationDelivery(root, blocked);
        return blocked;
      }
      const adapter = adapters[current.provider];
      if (!adapter) {
        const unavailable: IntegrationDelivery = { ...current, state: "not-configured", reason: "provider-adapter-unconfigured", updatedAt: at };
        await saveIntegrationDelivery(root, unavailable);
        return unavailable;
      }
      const attempting: IntegrationDelivery = { ...current, attempts: current.attempts + 1, updatedAt: at };
      try {
        const result = await adapter.deliver(attempting);
        if ("externalRef" in result) {
          if (!result.externalRef.trim() || result.externalRef.length > 300 || /[\u0000-\u001f\u007f]/.test(result.externalRef)) throw new Error("Invalid provider reference");
          const delivered: IntegrationDelivery = { ...attempting, state: "delivered", externalRef: result.externalRef, updatedAt: now() };
          assertTimestamp(delivered.updatedAt, "integration delivery timestamp");
          await saveIntegrationDelivery(root, delivered);
          return delivered;
        }
        const unknown: IntegrationDelivery = { ...attempting, state: "unknown", reason: "provider-error", updatedAt: now() };
        assertTimestamp(unknown.updatedAt, "integration delivery timestamp");
        await saveIntegrationDelivery(root, unknown);
        return unknown;
      } catch {
        const unknown: IntegrationDelivery = { ...attempting, state: "unknown", reason: "provider-error", updatedAt: now() };
        assertTimestamp(unknown.updatedAt, "integration delivery timestamp");
        await saveIntegrationDelivery(root, unknown);
        return unknown;
      }
    },

    async listDeliveries(principal) {
      ensurePrincipal(principal);
      return (await listIntegrationDeliveries(root, principal.userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    },
  };
}
