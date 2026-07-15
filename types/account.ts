export type WorkspaceType = 'workspace' | 'personal';

// User-supplied Google Cloud OAuth credentials — never QuickCast's own.
// Stored per-account since each connected Google account may use a
// different Google Cloud project. clientSecret is optional: a "Web
// application" type OAuth client does have one, and Google's token endpoint
// may require it alongside PKCE for that client type; a "Chrome Extension"
// type client has no secret at all (see lib/oauth.ts).
export interface AccountCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface AccountTokens {
  accessToken: string;
  refreshToken: string;
  // ms since epoch; access tokens are refreshed proactively once expired.
  expiresAt: number;
}

export interface StorageQuota {
  usageBytes: number;
  limitBytes: number | null; // null = unlimited (some Workspace plans)
}

export interface Account {
  id: string;
  email: string;
  avatarUrl: string | null;
  workspaceType: WorkspaceType;
  isDefault: boolean;
  credentials: AccountCredentials;
  tokens: AccountTokens;
  quota: StorageQuota | null;
  connectedAt: number;
}

export type AccountsById = Record<string, Account>;

// Auth material threaded through the offscreen:prepare message. The
// offscreen document (entrypoints/offscreen/main.ts) cannot read
// chrome.storage.local itself — see lib/drive.ts's driveFetchWithAuth — so
// background.ts resolves the account (refreshing the token first if it's
// close to expiry) and passes exactly what's needed to call the Drive API
// directly, rather than having the offscreen document look anything up.
export interface DriveAuth {
  accountId: string;
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
}
