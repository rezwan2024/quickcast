import { getAccount, updateAccount } from '@/lib/accounts-storage';
import { refreshAccessToken } from '@/lib/oauth';
import type { DriveAuth, StorageQuota, WorkspaceType } from '@/types/account';

// Google's API error responses are JSON with a real, specific reason
// (e.g. "Drive API has not been used in project ... before or it is
// disabled", or "insufficientPermissions" for a missing OAuth scope) — far
// more useful than the bare HTTP status this codebase was previously
// surfacing everywhere ("(403)"), which left no way to tell a disabled API
// from a missing scope from an actual quota issue without opening devtools
// and re-running the request by hand. Every throw site below now includes
// this instead.
async function describeDriveError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const message = body.error?.message;
    const reason = body.error?.errors?.[0]?.reason;
    if (message) {
      // "insufficientPermissions" specifically means the connected account's
      // access token doesn't carry the drive.file scope — almost always
      // because that account's Google Cloud project's OAuth consent screen
      // never had drive.file added under "Data Access"/"Scopes" at all, so
      // Google silently omitted it from the token during consent rather than
      // erroring out at that point. Confirmed exactly this way once already
      // (see progress.md's decisions log) — worth a direct, actionable hint
      // rather than making whoever hits this rediscover the same fix.
      const hint =
        reason === 'insufficientPermissions'
          ? ' — this account\'s Google Cloud OAuth consent screen likely doesn\'t have the Drive (drive.file) scope added under "Data Access". Add it there, then disconnect and reconnect this account in Settings (an existing token can\'t pick up a newly-added scope on its own).'
          : '';
      return (reason ? `${response.status} ${reason}: ${message}` : `${response.status}: ${message}`) + hint;
    }
  } catch {
    // Body wasn't JSON (or was empty) — fall back to the bare status below.
  }
  return `${response.status}`;
}

export interface GoogleUserInfo {
  email: string;
  avatarUrl: string | null;
  workspaceType: WorkspaceType;
}

// Called once, right after authorizeAccount() returns a fresh access token —
// no refresh handling needed since the token can't have expired yet.
export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Failed to fetch account profile (${await describeDriveError(response)}).`);
  const json = (await response.json()) as { email: string; picture?: string; hd?: string };
  return {
    email: json.email,
    avatarUrl: json.picture ?? null,
    // Google-issued "hd" (hosted domain) claim is only present for Workspace
    // accounts — personal Gmail accounts never have it.
    workspaceType: json.hd ? 'workspace' : 'personal',
  };
}

export async function fetchStorageQuota(accessToken: string): Promise<StorageQuota> {
  const url = 'https://www.googleapis.com/drive/v3/about?fields=storageQuota';
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Failed to fetch Drive storage quota (${await describeDriveError(response)}).`);
  const json = (await response.json()) as { storageQuota?: { usage?: string; limit?: string } };
  return {
    usageBytes: Number(json.storageQuota?.usage ?? 0),
    // Some Workspace plans have no limit field at all — treat as unlimited.
    limitBytes: json.storageQuota?.limit ? Number(json.storageQuota.limit) : null,
  };
}

// Authenticated Drive/Google API call for a stored account. On a 401 (expired
// access token), refreshes via the account's refresh token, persists the new
// access token, and retries exactly once — per plan.md's Phase 2 requirement.
export async function driveFetch(accountId: string, input: string, init: RequestInit = {}): Promise<Response> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`No stored account with id ${accountId}`);

  const withAuth = (token: string): RequestInit => ({
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });

  let response = await fetch(input, withAuth(account.tokens.accessToken));
  if (response.status !== 401) return response;

  const refreshed = await refreshAccessToken(account.credentials, account.tokens.refreshToken);
  await updateAccount(accountId, { tokens: { ...account.tokens, ...refreshed } });

  response = await fetch(input, withAuth(refreshed.accessToken));
  return response;
}

// Like fetchStorageQuota, but for an account already sitting in storage —
// goes through driveFetch (accountId-based) instead of a raw fetch with a
// static token, so a stale/expired access token gets refreshed and retried
// automatically instead of just failing. Used to retry a quota fetch that
// didn't succeed at connect time (see entrypoints/settings/App.tsx), when
// fetchStorageQuota's plain accessToken form isn't an option since the
// account wasn't in storage yet at that point.
export async function fetchStorageQuotaForAccount(accountId: string): Promise<StorageQuota> {
  const response = await driveFetch(accountId, 'https://www.googleapis.com/drive/v3/about?fields=storageQuota');
  if (!response.ok) throw new Error(`Failed to fetch Drive storage quota (${await describeDriveError(response)}).`);
  const json = (await response.json()) as { storageQuota?: { usage?: string; limit?: string } };
  return {
    usageBytes: Number(json.storageQuota?.usage ?? 0),
    limitBytes: json.storageQuota?.limit ? Number(json.storageQuota.limit) : null,
  };
}

// --- Phase 3: chunked resumable upload ---------------------------------
//
// Drive's resumable upload protocol: https://developers.google.com/drive/api/guides/manage-uploads#resumable
// 1. POST metadata to get a session URI back in the Location header.
// 2. PUT successive byte ranges to that URI with Content-Range: bytes
//    {start}-{end}/{total|'*'} — every PUT except the last must carry a
//    number of bytes that's a multiple of 256 KiB.
// 3. The final PUT (the one that completes the file) states the real total
//    size instead of '*' and, on success, returns the created file resource.
//
// The functions below all take a DriveAuth object rather than an accountId —
// they run exclusively from the offscreen document (entrypoints/offscreen/main.ts),
// which cannot read chrome.storage.local (confirmed empirically: getAccount()
// there threw "Cannot read properties of undefined (reading 'local')" —
// chrome.storage is not available in that context). background.ts resolves
// the account and passes the auth material through the offscreen:prepare
// message instead.

const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';

// Like driveFetch, but for the offscreen document: takes auth material
// directly instead of looking an account up by id. Refreshes on a 401 and
// mutates `auth.accessToken` in place so subsequent calls on the same
// DriveAuth object (held on the offscreen session) reuse the refreshed
// token — but can't persist it back to chrome.storage.local the way
// driveFetch does; the next recording's prepare() call resolves a fresh
// token from background regardless, so this only matters mid-recording.
export async function driveFetchWithAuth(auth: DriveAuth, input: string, init: RequestInit = {}): Promise<Response> {
  const withAuth = (token: string): RequestInit => ({
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });

  let response = await fetch(input, withAuth(auth.accessToken));
  if (response.status !== 401) return response;

  const refreshed = await refreshAccessToken({ clientId: auth.clientId, clientSecret: auth.clientSecret }, auth.refreshToken);
  auth.accessToken = refreshed.accessToken;
  response = await fetch(input, withAuth(refreshed.accessToken));
  return response;
}

// Initiates a resumable upload session for a not-yet-uploaded recording and
// returns the session URI chunks should be PUT to. `parents` places the file
// straight into the right monthly folder (see ensureMonthlyFolder below) —
// Drive doesn't support moving a still-in-progress resumable upload later,
// so this has to be set at initiation time.
export async function initiateResumableUpload(auth: DriveAuth, fileName: string, parents?: string[]): Promise<string> {
  const response = await driveFetchWithAuth(auth, UPLOAD_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/webm',
    },
    body: JSON.stringify({ name: fileName, mimeType: 'video/webm', ...(parents ? { parents } : {}) }),
  });
  if (!response.ok) throw new Error(`Failed to initiate resumable upload (${await describeDriveError(response)}).`);
  const sessionUri = response.headers.get('Location');
  if (!sessionUri) throw new Error('Drive did not return a resumable upload session URI.');
  return sessionUri;
}

export interface UploadChunkResult {
  // 308 = Drive accepted the bytes and is waiting for more ("Resume Incomplete").
  // 200/201 = this PUT completed the file — fileId is set.
  status: number;
  fileId?: string;
}

// Uploads one byte range of the recording. `totalSize` is null while the
// recording is still in progress (unknown-size session, Content-Range's
// total is '*') and the real byte count only once Stop has flushed the
// final chunk.
export async function uploadChunk(
  auth: DriveAuth,
  sessionUri: string,
  blob: Blob,
  start: number,
  totalSize: number | null,
): Promise<UploadChunkResult> {
  const end = start + blob.size - 1;
  // A zero-byte final chunk (recording ended exactly on a 256 KiB boundary)
  // has no byte range to report — only the total.
  const range = blob.size > 0 ? `bytes ${start}-${end}/${totalSize ?? '*'}` : `bytes */${totalSize ?? '*'}`;
  const response = await driveFetchWithAuth(auth, sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': range },
    body: blob,
  });
  if (response.status === 308) return { status: 308 };
  if (response.status === 200 || response.status === 201) {
    const json = (await response.json()) as { id: string };
    return { status: response.status, fileId: json.id };
  }
  throw new Error(`Unexpected upload response (${await describeDriveError(response)}).`);
}

// Asks Drive how many bytes of this session it has actually received —
// used to reconcile local state after a network drop, since a failed PUT
// doesn't tell us whether the bytes were received before the connection
// dropped. Returns the number of confirmed bytes (0 if none yet).
export async function queryUploadedOffset(
  auth: DriveAuth,
  sessionUri: string,
  totalSize: number | null,
): Promise<number> {
  const response = await driveFetchWithAuth(auth, sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes */${totalSize ?? '*'}` },
  });
  if (response.status === 200 || response.status === 201) {
    // Already fully received/completed.
    return totalSize ?? Number.MAX_SAFE_INTEGER;
  }
  if (response.status !== 308) throw new Error(`Unexpected status while querying upload offset (${await describeDriveError(response)}).`);
  const range = response.headers.get('Range'); // e.g. "bytes=0-524287"
  if (!range) return 0;
  const match = /bytes=0-(\d+)/.exec(range);
  return match ? Number(match[1]) + 1 : 0;
}

// "anyone with the link can view" — per requirements.md §6 / plan.md Phase 3.
export async function setAnyoneWithLinkPermission(auth: DriveAuth, fileId: string): Promise<void> {
  const response = await driveFetchWithAuth(auth, `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!response.ok) throw new Error(`Failed to set sharing permission (${await describeDriveError(response)}).`);
}

// --- Phase 4: Drive folder organization --------------------------------
//
// Runs from the offscreen document (via driveFetchWithAuth), right before
// initiating the resumable upload — Drive has no "move" for an in-progress
// resumable session, so the folder must be resolved before that call.

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Escapes a single-quote for safe embedding in a Drive `q` filter string —
// folder names here are either QuickCast's own constant or a YYYY-MM string,
// but this guards against the constant ever changing without remembering why.
function escapeForDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findFolder(auth: DriveAuth, name: string, parentId: string | null): Promise<string | null> {
  const parentClause = parentId ? `'${parentId}' in parents` : `'root' in parents`;
  const q = `name='${escapeForDriveQuery(name)}' and mimeType='${FOLDER_MIME_TYPE}' and ${parentClause} and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const response = await driveFetchWithAuth(auth, url);
  if (!response.ok) throw new Error(`Failed to look up folder "${name}" (${await describeDriveError(response)}).`);
  const json = (await response.json()) as { files: { id: string }[] };
  return json.files[0]?.id ?? null;
}

async function createFolder(auth: DriveAuth, name: string, parentId: string | null): Promise<string> {
  const response = await driveFetchWithAuth(auth, 'https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  if (!response.ok) throw new Error(`Failed to create folder "${name}" (${await describeDriveError(response)}).`);
  const json = (await response.json()) as { id: string };
  return json.id;
}

const ROOT_FOLDER_NAME = 'QuickCast Recordings';

// Ensures "QuickCast Recordings/{yearMonth}/" exists — creating whichever
// part is missing — and returns the leaf (month) folder's id to use as the
// upload's `parents`. `yearMonth` looks like "2026-07".
export async function ensureMonthlyFolder(auth: DriveAuth, yearMonth: string): Promise<string> {
  const rootId = (await findFolder(auth, ROOT_FOLDER_NAME, null)) ?? (await createFolder(auth, ROOT_FOLDER_NAME, null));
  return (await findFolder(auth, yearMonth, rootId)) ?? (await createFolder(auth, yearMonth, rootId));
}

// Looks up the root "QuickCast Recordings" folder id for the popup's
// "View all in Drive" link (requirements.md §7) — accountId-based (via
// driveFetch), since the popup is a normal extension page with full
// chrome.storage.local access, not the offscreen document. Returns null
// (rather than creating one) if it doesn't exist yet — nothing to view if
// this account has never uploaded a recording.
export async function findRootRecordingsFolderId(accountId: string): Promise<string | null> {
  const q = `name='${escapeForDriveQuery(ROOT_FOLDER_NAME)}' and mimeType='${FOLDER_MIME_TYPE}' and 'root' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const response = await driveFetch(accountId, url);
  if (!response.ok) throw new Error(`Failed to look up the recordings folder (${await describeDriveError(response)}).`);
  const json = (await response.json()) as { files: { id: string }[] };
  return json.files[0]?.id ?? null;
}

// `?authuser={email}` tells Google which of the browser's currently
// signed-in Google accounts to render drive.google.com as — without it, a
// plain drive.google.com link always opens in whatever account Chrome's
// browser profile happens to be signed into by default, which may not be
// the account that actually owns the recordings being linked to at all.
// Used by both Settings' "View in Drive" (per account row) and the popup
// history panel's "View all in Drive" (the default account).
export function driveUrlWithAuthuser(path: string, email: string): string {
  return `https://drive.google.com${path}?authuser=${encodeURIComponent(email)}`;
}

// --- Phase 4: share screen ----------------------------------------------
//
// Runs from entrypoints/share/ — a normal extension page with full
// chrome.storage.local access, so these use the accountId-based driveFetch
// (not driveFetchWithAuth) like Settings does.

export interface DriveFileMetadata {
  name: string;
  webViewLink: string;
}

export async function getFileMetadata(accountId: string, fileId: string): Promise<DriveFileMetadata> {
  const response = await driveFetch(accountId, `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,webViewLink`);
  if (!response.ok) throw new Error(`Failed to fetch file metadata (${await describeDriveError(response)}).`);
  return response.json();
}

// Polled every few seconds by the share screen while a fresh upload's local
// blob is standing in for playback — videoMediaMetadata is only populated
// once Drive has finished transcoding the file, so its presence (regardless
// of the field values themselves) is exactly the "ready to swap to the Drive
// preview" signal.
export async function getVideoMediaMetadata(accountId: string, fileId: string): Promise<boolean> {
  const response = await driveFetch(accountId, `https://www.googleapis.com/drive/v3/files/${fileId}?fields=videoMediaMetadata`);
  if (!response.ok) throw new Error(`Failed to poll video processing status (${await describeDriveError(response)}).`);
  const json = (await response.json()) as { videoMediaMetadata?: unknown };
  return json.videoMediaMetadata !== undefined;
}

export async function renameFile(accountId: string, fileId: string, name: string): Promise<void> {
  const response = await driveFetch(accountId, `https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`Failed to rename file (${await describeDriveError(response)}).`);
}

export async function updateFileDescription(accountId: string, fileId: string, description: string): Promise<void> {
  const response = await driveFetch(accountId, `https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  if (!response.ok) throw new Error(`Failed to update file description (${await describeDriveError(response)}).`);
}

export async function deleteFile(accountId: string, fileId: string): Promise<void> {
  const response = await driveFetch(accountId, `https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' });
  // A 404 means it's already gone — treat that as success, not an error.
  if (!response.ok && response.status !== 404) throw new Error(`Failed to delete file (${await describeDriveError(response)}).`);
}

export async function downloadFileMedia(accountId: string, fileId: string): Promise<Blob> {
  const response = await driveFetch(accountId, `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  if (!response.ok) throw new Error(`Failed to download file from Drive (${await describeDriveError(response)}).`);
  return response.blob();
}
