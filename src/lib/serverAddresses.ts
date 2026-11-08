/**
 * A server can have two addresses: the direct one at home, and one that works
 * from anywhere (a tunnel or proxy). What was made from one of them, a cover's
 * or a song's address, can be asked for at the other. No device code here.
 */
export type Reach = "home" | "away" | "offline";

export interface Addresses {
  home: string;
  away?: string;
}

/** The same thing at the address that answers now. */
export function atAddress(url: string, addresses: Addresses, current: string): string {
  for (const address of [addresses.home, addresses.away]) {
    if (address && address !== current && (url === address || url.startsWith(`${address}/`))) {
      return current + url.slice(address.length);
    }
  }
  return url;
}

/** What identifies a picture wherever it comes from: the address without its server. */
export const withoutServer = (url: string): string => url.replace(/^https?:\/\/[^/]+/i, "");

/**
 * Which address to use, from the ids they answered with (null: no answer). The
 * direct way wins when it works. Another server at the same private address, in
 * somebody else's home, doesn't count: this login isn't for it.
 */
export function pickAddress(
  addresses: Addresses,
  serverId: string | undefined,
  homeAnswer: string | null,
  awayAnswer: string | null
): { reach: Reach; server: string | null; serverId?: string } {
  const ours = (answer: string | null): answer is string => answer !== null && (!serverId || answer === serverId);
  if (ours(homeAnswer)) return { reach: "home", server: addresses.home, serverId: homeAnswer };
  if (addresses.away && ours(awayAnswer)) return { reach: "away", server: addresses.away, serverId: awayAnswer };
  return { reach: "offline", server: null };
}
