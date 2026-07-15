import type { Account, AccountsById } from '@/types/account';

const STORAGE_KEY = 'quickcast:accounts';

export async function getAllAccounts(): Promise<AccountsById> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as AccountsById | undefined) ?? {};
}

export async function getAccount(id: string): Promise<Account | undefined> {
  const accounts = await getAllAccounts();
  return accounts[id];
}

export async function saveAccount(account: Account): Promise<void> {
  const accounts = await getAllAccounts();
  accounts[account.id] = account;
  await chrome.storage.local.set({ [STORAGE_KEY]: accounts });
}

export async function updateAccount(id: string, patch: Partial<Account>): Promise<Account> {
  const accounts = await getAllAccounts();
  const existing = accounts[id];
  if (!existing) throw new Error(`No account with id ${id}`);
  const updated = { ...existing, ...patch };
  accounts[id] = updated;
  await chrome.storage.local.set({ [STORAGE_KEY]: accounts });
  return updated;
}

export async function removeAccount(id: string): Promise<void> {
  const accounts = await getAllAccounts();
  delete accounts[id];

  // If the removed account was default, promote whichever account remains
  // first — there must always be exactly one default when accounts exist.
  const remaining = Object.values(accounts);
  if (remaining.length > 0 && !remaining.some((a) => a.isDefault)) {
    remaining[0].isDefault = true;
    accounts[remaining[0].id] = remaining[0];
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: accounts });
}

export async function setDefaultAccount(id: string): Promise<void> {
  const accounts = await getAllAccounts();
  for (const account of Object.values(accounts)) {
    account.isDefault = account.id === id;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: accounts });
}
