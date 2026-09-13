/**
 * Adapter fuer eine Cloud-TSE nach dem Zuschnitt der fiskaly-SIGN-DE-API (v2).
 *
 * Bewusst als schmaler Adapter gebaut: der Vertrag mit dem TSE-Anbieter ist
 * eine Geschaeftsentscheidung, kein technisches Detail. Wechselt der Anbieter
 * (Swissbit Cloud, Deutsche Fiskal, epsilon), wird genau diese Datei ersetzt -
 * die restliche Anwendung kennt nur `TseClient`.
 *
 * WICHTIG - vor dem Produktivbetrieb zu pruefen:
 *   - Die Feldnamen und Endpunkte unten sind nach der oeffentlich
 *     dokumentierten Struktur der API gebaut. Sie sind *nicht* gegen eine
 *     echte Instanz getestet. Vor dem ersten echten Beleg gegen die
 *     Sandbox des Anbieters verifizieren.
 *   - Die TSE muss mit einem `client_id` pro Kasse registriert sein.
 *   - Die Kasse ist nach § 146a Abs. 4 AO innerhalb eines Monats dem
 *     Finanzamt zu melden (seit 2025 elektronisch ueber ELSTER).
 */

import {
  type FinishTransactionRequest,
  type StartTransactionRequest,
  TseError,
  type TseClient,
  type TseInfo,
  type TseResponse,
} from "./types.ts";

export interface FiskalyConfig {
  /** Basis-URL der API, z. B. `https://kassensichv-middleware.fiskaly.com/api/v2`. */
  readonly baseUrl: string;
  /** Id der TSS (Technical Security System) des Mandanten. */
  readonly tssId: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  /** Zeitlimit je Aufruf in Millisekunden. Am Kassenstand kurz halten. */
  readonly timeoutMs?: number;
}

interface FiskalyAuth {
  accessToken: string;
  /** Ablaufzeitpunkt als Millisekunden seit Epoch. */
  expiresAt: number;
}

/** Minimale `fetch`-Signatur, damit der Adapter auch in Tests laeuft. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export class FiskalyTse implements TseClient {
  private auth: FiskalyAuth | null = null;
  private cachedInfo: TseInfo | null = null;

  private readonly config: FiskalyConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: FiskalyConfig, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async info(): Promise<TseInfo> {
    if (this.cachedInfo) return this.cachedInfo;
    const body = await this.request<Record<string, unknown>>("GET", `/tss/${this.config.tssId}`);
    this.cachedInfo = {
      serialNumber: String(body["serial_number"] ?? ""),
      publicKey: String(body["public_key"] ?? ""),
      signatureAlgorithm: String(body["signature_algorithm"] ?? "ecdsa-plain-SHA256"),
      logTimeFormat: String(body["log_time_format"] ?? "utcTime"),
      certificate: body["certificate"] == null ? null : String(body["certificate"]),
    };
    return this.cachedInfo;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.info();
      return true;
    } catch {
      return false;
    }
  }

  async startTransaction(request: StartTransactionRequest): Promise<TseResponse> {
    return this.putTransaction(crypto.randomUUID(), 1, "ACTIVE", {
      clientId: request.clientId,
      processData: request.processData ?? "",
      processType: request.processType ?? "",
    });
  }

  async updateTransaction(request: FinishTransactionRequest): Promise<TseResponse> {
    return this.putTransaction(String(request.transactionNumber), 2, "ACTIVE", request);
  }

  async finishTransaction(request: FinishTransactionRequest): Promise<TseResponse> {
    return this.putTransaction(String(request.transactionNumber), 2, "FINISHED", request);
  }

  private async putTransaction(
    txId: string,
    revision: number,
    state: "ACTIVE" | "FINISHED",
    request: { clientId: string; processData: string; processType: string },
  ): Promise<TseResponse> {
    const body = await this.request<Record<string, unknown>>(
      "PUT",
      `/tss/${this.config.tssId}/tx/${txId}?tx_revision=${revision}`,
      {
        state,
        client_id: request.clientId,
        schema: { raw: { process_data: request.processData, process_type: request.processType } },
      },
    );
    return mapTransaction(body);
  }

  private async token(): Promise<string> {
    // 30 Sekunden Sicherheitsabstand: ein Token, das mitten im Bezahlvorgang
    // ablaeuft, kostet den Beleg.
    if (this.auth && this.auth.expiresAt > Date.now() + 30_000) return this.auth.accessToken;

    const body = await this.rawRequest<Record<string, unknown>>("POST", "/auth", {
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
    }, null);
    const accessToken = String(body["access_token"] ?? "");
    if (!accessToken) throw new TseError("TSE-Anmeldung lieferte kein Token");
    const expiresIn = Number(body["expires_in"] ?? 3600);
    this.auth = { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
    return accessToken;
  }

  private async request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const token = await this.token();
    try {
      return await this.rawRequest<T>(method, path, payload, token);
    } catch (error) {
      // Ein abgelaufenes Token aeussert sich als 401; einmal neu anmelden und
      // wiederholen, statt den Beleg scheitern zu lassen.
      if (error instanceof TseError && error.message.includes("401")) {
        this.auth = null;
        return this.rawRequest<T>(method, path, payload, await this.token());
      }
      throw error;
    }
  }

  private async rawRequest<T>(method: string, path: string, payload: unknown, token: string | null): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 8000);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers["authorization"] = `Bearer ${token}`;
      const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new TseError(`TSE antwortete mit ${response.status}: ${text.slice(0, 300)}`, {
          // 5xx und 429 sind voruebergehend, 4xx sind Fehler im Aufruf.
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof TseError) throw error;
      throw new TseError(`TSE nicht erreichbar: ${(error as Error).message}`, { retryable: true, cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Antwort der API auf das Domaenenmodell abbilden. */
export function mapTransaction(body: Record<string, unknown>): TseResponse {
  const signature = (body["signature"] ?? {}) as Record<string, unknown>;
  const number = Number(body["number"] ?? body["transaction_number"] ?? 0);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TseError("TSE-Antwort ohne Transaktionsnummer");
  }
  return {
    transactionNumber: number,
    signatureCounter: Number(signature["counter"] ?? 0),
    startTime: toIso(body["time_start"]),
    logTime: toIso(body["time_end"] ?? body["log_time"] ?? body["time_start"]),
    signature: String(signature["value"] ?? ""),
  };
}

/**
 * Die API liefert Unix-Sekunden. Auf dem Bon und in der DSFinV-K steht
 * ISO-8601 - die Umwandlung gehoert deshalb an die Systemgrenze, nicht in
 * die Anzeige.
 */
function toIso(value: unknown): string {
  if (typeof value === "number") return new Date(value * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (typeof value === "string" && value !== "") return value;
  throw new TseError(`TSE-Antwort ohne verwertbaren Zeitstempel: ${JSON.stringify(value)}`);
}
