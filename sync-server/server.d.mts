// Types for the desktop app, which runs this service for phones at home (electron/home-link-server.ts).
import type { IncomingMessage, RequestListener, Server } from "node:http";

export declare const VERSION: string;

export interface SyncServiceOptions {
  dataDir: string;
  jellyfinUrl?: string;
  /** whose documents a request is about (a 32-hex user id) instead of asking Jellyfin; nothing: not let in */
  authenticate?: (req: IncomingMessage) => string | null | undefined | Promise<string | null | undefined>;
}

export declare function createSyncHandler(options: SyncServiceOptions): RequestListener;
export declare function createSyncServer(options: SyncServiceOptions): Server;
