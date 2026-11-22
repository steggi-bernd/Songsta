/**
 * Where this computer's own sync service for phones at home answers right now, and with which token:
 * set by home-link.ts while it runs, read by home-sync.ts for this computer's own sync. Kept apart so
 * the line to the sync service needs nothing of the service itself.
 */
export interface HomeLinkLogin {
  address: string;
  authorization: string;
  serviceId: string;
  deviceId: string;
}

let login: HomeLinkLogin | null = null;

export const homeLinkLogin = (): HomeLinkLogin | null => login;

export function setHomeLinkLogin(next: HomeLinkLogin | null): void {
  login = next;
}
