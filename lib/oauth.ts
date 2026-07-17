import type { AccountCredentials, AccountTokens } from '@/types/account';

// drive.file: per-file access, only files this app creates — non-sensitive
// scope, no Google verification required (see CLAUDE.md). userinfo scopes
// are needed only to show the connected email/avatar in Settings.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// A client ID looks like "<digits>-<alphanumerics>.apps.googleusercontent.com".
const CLIENT_ID_PATTERN = /^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/;

export function validateCredentials(clientId: string): string | null {
  if (!clientId.trim()) return 'Client ID is required.';
  if (!CLIENT_ID_PATTERN.test(clientId.trim())) {
    return 'That doesn’t look like a Google OAuth Client ID (should end in .apps.googleusercontent.com).';
  }
  return null;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  // Google's token endpoint returns the actual granted scopes directly in
  // this same response — authoritative and immediate, unlike a separate
  // tokeninfo introspection call afterward, which is a different service and
  // can lag behind by several seconds (see the retry loop this scope check
  // replaces as the primary source of truth for).
  scope?: string;
}

function expiresAtFrom(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Google's "Chrome Extension" OAuth client type blocks the implicit grant
// (response_type=token) — deprecated since 2019 — so that flow fails with
// redirect_uri_mismatch no matter what's configured; Google rejects the flow
// type itself before ever checking the redirect URI. The client type that
// actually works from an extension is "Web application": it has a real
// Authorized-redirect-URIs field (add
// https://<extension-id>.chromiumapp.org/ there), and supports the
// authorization-code grant. PKCE stands in for a client secret, since a
// secret bundled into an extension can never really be kept confidential
// anyway: a random verifier is kept here, only its SHA-256 hash
// (code_challenge) is sent with the authorization request, and the raw
// verifier is sent at token-exchange time instead of a secret.
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Google's consent screen can present Drive access as its own separate,
// unchecked item — distinct from the main "Continue"/"Allow" click — for an
// unverified app on a personal (non-Workspace) account; if it isn't
// explicitly checked, Google silently issues a token without that scope, with
// nothing in the redirect, the token exchange, or any status code indicating
// it happened. Google's own token-introspection endpoint reports exactly
// which scopes actually landed on a token, so calling it right after the
// exchange catches a missing grant immediately — at connect time, in this
// modal, with a clear actionable message — instead of only surfacing as a
// 403 minutes later during an unrelated recording.
async function fetchGrantedScopes(accessToken: string, attemptLabel: string): Promise<string[]> {
  const response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
  if (!response.ok) {
    // Introspection failing is a diagnostic call failing, not the actual
    // authorization — don't block a connection on it; the real Drive calls
    // will still surface a clear error later (see lib/drive.ts) if the scope
    // genuinely is missing.
    console.warn('[QuickCast][oauth]', attemptLabel, 'tokeninfo lookup failed — skipping the granted-scope check', response.status);
    return [DRIVE_FILE_SCOPE];
  }
  // Logged in full (not just the scope check's pass/fail) so a repro of the
  // "works on 2nd attempt only" report can be compared attempt-by-attempt —
  // email/aud/azp confirm which Google account and OAuth client the token
  // actually belongs to, independent of what the user saw on Google's own
  // consent screens.
  const json = (await response.json()) as { scope?: string; email?: string; aud?: string; azp?: string; expires_in?: string };
  console.log('[QuickCast][oauth]', attemptLabel, 'tokeninfo response:', json);
  return json.scope?.split(' ') ?? [];
}

// Launches Chrome's native OAuth popup (chrome.identity.launchWebAuthFlow),
// then exchanges the returned authorization code for tokens via PKCE.
// Requires the user's own "Web application" type OAuth Client ID from
// Google Cloud Console, with this extension's chromiumapp.org redirect URI
// added to it — QuickCast never has its own credentials (see requirements.md).
export async function authorizeAccount(credentials: AccountCredentials): Promise<AccountTokens> {
  // Logged so a redirect_uri_mismatch can be root-caused: this exact value
  // must be added as an Authorized redirect URI on the Web application OAuth
  // client in Google Cloud.
  console.log('[QuickCast][oauth] extension ID:', chrome.runtime.id);
  const redirectUri = chrome.identity.getRedirectURL();
  console.log('[QuickCast][oauth] redirect_uri (add this as an Authorized redirect URI on the OAuth client):', redirectUri);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', credentials.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  // select_account: with multiple Google accounts signed into the browser,
  // Google otherwise silently auto-picks the default one — if that's not the
  // account whose Cloud project this Client ID belongs to, the user gets a
  // confusing "not a test user" error instead of ever seeing a chooser.
  // consent: forces Google to always show the consent screen and return a
  // refresh_token, even if this Client ID has been authorized by this
  // Google account once before — without it, a reconnect can silently reuse
  // a cached grant and skip showing consent at all.
  authUrl.searchParams.set('prompt', 'select_account consent');
  // Without this, Google can silently union a fresh request's scopes with
  // whatever was granted in a *previous* authorization for this client_id —
  // so a reconnect meant to pick up a newly-added scope (e.g. drive.file
  // just added to the consent screen's configured scopes) could still come
  // back with the stale, narrower grant from before. Forcing this to false
  // means the token reflects exactly (and only) what SCOPES above requests.
  authUrl.searchParams.set('include_granted_scopes', 'false');

  console.log('[QuickCast][oauth] Launching auth flow with URL:', authUrl.toString());
  const resultUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'No response URL'));
      } else {
        resolve(responseUrl);
      }
    });
  });

  const code = new URL(resultUrl).searchParams.get('code');
  if (!code) {
    const error = new URL(resultUrl).searchParams.get('error');
    throw new Error(error ? `Google denied authorization: ${error}` : 'No authorization code returned.');
  }

  const body = new URLSearchParams({
    code,
    client_id: credentials.clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  // Web application clients are confidential — Google's token endpoint may
  // reject the exchange without a client_secret even with PKCE in play.
  // Chrome Extension type clients have no secret at all, so this is omitted
  // whenever the user didn't paste one.
  if (credentials.clientSecret) {
    body.set('client_secret', credentials.clientSecret);
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Token exchange failed (${response.status}). Double-check the Client ID and that the redirect URI is added to the OAuth client.`,
    );
  }
  const json = (await response.json()) as TokenResponse;
  if (!json.refresh_token) {
    throw new Error('Google did not return a refresh token. Try disconnecting this account in Google’s permissions and reconnecting.');
  }

  console.log('[QuickCast][oauth] token exchange response scope field:', json.scope);

  // Prefer the token endpoint's own `scope` field — it's part of the same
  // atomic response as the tokens themselves, so there's no separate service
  // or propagation delay to race against. A retry loop against the separate
  // tokeninfo introspection endpoint (kept below as a fallback for the rare
  // case Google omits `scope` from the exchange response) turned out NOT to
  // fix a reproducible "fails on 1st Connect, succeeds identically on 2nd"
  // report even at 6 retries over 12s — logging both this field and every
  // introspection attempt's full response is what the next repro needs to
  // show whether the exchange response itself already lacks the scope
  // (a real, immediate denial) vs. only the separate introspection call
  // lagging (this endpoint's own actual behavior, still not fully explained).
  let grantedScopes = json.scope ? json.scope.split(' ') : null;
  if (!grantedScopes) {
    grantedScopes = await fetchGrantedScopes(json.access_token, 'attempt 0 (no scope in exchange response)');
    for (let attempt = 1; !grantedScopes.includes(DRIVE_FILE_SCOPE) && attempt <= 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      grantedScopes = await fetchGrantedScopes(json.access_token, `attempt ${attempt}`);
    }
  }
  if (!grantedScopes.includes(DRIVE_FILE_SCOPE)) {
    throw new Error(
      'Google did not grant Drive access for this account, even though it was requested. On the consent screen, Drive access can appear as its own separate checkbox — make sure it\'s checked before clicking Continue, then try connecting again.',
    );
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: expiresAtFrom(json.expires_in),
  };
}

// Exchanges a refresh token for a new access token. Never returns a new
// refresh token — the original one keeps working indefinitely unless revoked.
export async function refreshAccessToken(
  credentials: AccountCredentials,
  refreshToken: string,
): Promise<Pick<AccountTokens, 'accessToken' | 'expiresAt'>> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: credentials.clientId,
    grant_type: 'refresh_token',
  });
  // Same reasoning as the code exchange above: confidential (Web
  // application) clients may require this even for a refresh_token grant.
  if (credentials.clientSecret) {
    body.set('client_secret', credentials.clientSecret);
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}). The account may need to be reconnected.`);
  }
  const json = (await response.json()) as TokenResponse;
  return { accessToken: json.access_token, expiresAt: expiresAtFrom(json.expires_in) };
}
