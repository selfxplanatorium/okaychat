import { randomBytes } from "node:crypto";
import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from "@ai-sdk/mcp";
import { readOAuth, writeOAuth } from "./store.js";

interface Stored {
  tokens?: OAuthTokens;
  client?: OAuthClientInformation;
  dynamic?: boolean;
  server?: OAuthAuthorizationServerInformation;
  verifier?: string;
  state?: string;
}

/** Pending browser authorizations, by OAuth state. Lost on restart, which only means the user clicks Authorize again. */
const pendingByState = new Map<string, { userId: string; serverId: string; expiresAt: number }>();
const PENDING_TTL_MS = 15 * 60_000;

/** Takes a pending authorization once. Expired or unknown states return undefined. */
export function takePending(state: string): { userId: string; serverId: string } | undefined {
  const pending = pendingByState.get(state);
  pendingByState.delete(state);
  return pending && pending.expiresAt > Date.now() ? pending : undefined;
}

/**
 * Per (user, server) OAuth storage, encrypted (see readOAuth: owners in mcp_servers, viewers of a shared server in mcp_server_users).
 * `redirectToAuthorization` cannot open a browser on a server, so it records the URL for the UI to open.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: string;

  constructor(
    private readonly userId: string,
    private readonly serverId: string,
    private readonly callbackUrl: string,
  ) {}

  private read(): Stored {
    return readOAuth<Stored>(this.userId, this.serverId) ?? {};
  }
  private write(patch: Partial<Stored>) {
    writeOAuth(this.userId, this.serverId, { ...this.read(), ...patch });
  }

  get redirectUrl() {
    return this.callbackUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "okaychat",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.write({ tokens });
  }
  clientInformation() {
    return this.read().client;
  }
  saveClientInformation(client: OAuthClientInformation) {
    this.write({ client, dynamic: true });
  }
  isClientInformationDynamicallyRegistered() {
    return this.read().dynamic === true;
  }
  authorizationServerInformation() {
    return this.read().server;
  }
  saveAuthorizationServerInformation(server: OAuthAuthorizationServerInformation) {
    this.write({ server });
  }
  saveCodeVerifier(verifier: string) {
    this.write({ verifier });
  }
  codeVerifier() {
    const verifier = this.read().verifier;
    if (!verifier) throw new Error("No PKCE verifier stored");
    return verifier;
  }
  state() {
    const state = randomBytes(32).toString("base64url");
    const now = Date.now();
    // Abandoned authorizations would otherwise accumulate for the life of the process.
    for (const [key, entry] of pendingByState) if (entry.expiresAt <= now) pendingByState.delete(key);
    pendingByState.set(state, { userId: this.userId, serverId: this.serverId, expiresAt: now + PENDING_TTL_MS });
    return state;
  }
  saveState(state: string) {
    this.write({ state });
  }
  storedState() {
    return this.read().state;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url.toString();
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier", context?: { tokens: OAuthTokens }) {
    const current = this.read();
    if (scope === "all") return writeOAuth(this.userId, this.serverId, null);
    if (scope === "client") return this.write({ client: undefined, dynamic: undefined });
    if (scope === "verifier") return this.write({ verifier: undefined });
    // Only drop the generation that failed, so a concurrent refresh is kept.
    if (!context || current.tokens?.access_token === context.tokens.access_token) this.write({ tokens: undefined });
  }
}
