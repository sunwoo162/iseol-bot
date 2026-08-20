const FIGMA_API_BASE = "https://api.figma.com";

export type FigmaFileRef = {
  key: string;
  url: string;
};

export type FigmaVersionWebhookPayload = {
  event_type: "FILE_VERSION_UPDATE";
  webhook_id: string | number;
  file_key: string;
  file_name: string;
  version_id: string;
  label: string;
  description?: string;
  created_at: string;
  timestamp: string;
  passcode: string;
  triggered_by?: {
    id?: string;
    handle?: string;
  };
};

export type FigmaPingPayload = {
  event_type: "PING";
  webhook_id: string | number;
  passcode: string;
  timestamp: string;
};

export function parseFigmaFile(input: string): FigmaFileRef {
  const url = new URL(input.trim());
  const host = url.hostname.toLowerCase();

  if (url.protocol !== "https:" || (host !== "figma.com" && host !== "www.figma.com")) {
    throw new Error("Figma 링크는 https://www.figma.com/... 형식만 사용할 수 있습니다.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const supportedKinds = new Set(["design", "file", "board", "proto"]);

  if (parts.length < 2 || !supportedKinds.has(parts[0] ?? "") || !parts[1]) {
    throw new Error("Figma 메인 주소가 아니라 실제 디자인 파일 링크를 입력해주세요. 예: https://www.figma.com/design/...");
  }

  return {
    key: parts[1],
    url: url.toString(),
  };
}

export class FigmaWebhookService {
  private readonly endpoint: string;

  constructor(
    private readonly token: string,
    publicBaseUrl: string,
    private readonly passcode: string,
  ) {
    const base = publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`;
    this.endpoint = new URL("webhooks/figma", base).toString();
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${FIGMA_API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Figma-Token": this.token,
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Figma API 요청 실패 (${response.status}): ${body || response.statusText}`);
    }

    return response;
  }

  async createVersionWebhook(fileKey: string, description: string): Promise<string> {
    const response = await this.request("/v2/webhooks", {
      method: "POST",
      body: JSON.stringify({
        event_type: "FILE_VERSION_UPDATE",
        context: "file",
        context_id: fileKey,
        endpoint: this.endpoint,
        passcode: this.passcode,
        description,
      }),
    });

    const data = await response.json() as { id?: string | number };
    if (data.id === undefined || data.id === null) {
      throw new Error("Figma Webhook ID를 확인할 수 없습니다.");
    }

    return String(data.id);
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request(`/v2/webhooks/${encodeURIComponent(webhookId)}`, {
      method: "DELETE",
    });
  }
}
