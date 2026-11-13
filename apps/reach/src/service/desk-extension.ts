// Copyright (c) Ray Zhang. Optional composition boundary; no Desk runtime import.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeskDevices } from './desk-devices.ts';
export interface DeskContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  userId: string;
  sessionId: string;
  sessionValid(): boolean;
  body(): Promise<unknown>;
  devices?: DeskDevices;
}
export interface DeskExtension {
  bindDevices?(factory:(userId:string)=>DeskDevices):void;
  serveStatic?(route: string, method: string, response: ServerResponse, rayLogin: boolean): Promise<boolean>;
  handle(context: DeskContext): Promise<void>;
  revoke(sessionId: string): void;
  close(): Promise<void>;
}
