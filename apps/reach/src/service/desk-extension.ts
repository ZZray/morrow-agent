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
  reconfigure?(model: { endpoint: string; model: string; token: string; capabilities?: { contextWindow: number; maxTokens: number; imageInput: boolean } }): void;
  serveStatic?(route: string, method: string, response: ServerResponse, rayLogin: boolean, pinOnly?: boolean): Promise<boolean>;
  handle(context: DeskContext): Promise<void>;
  revoke(sessionId: string): void;
  close(): Promise<void>;
}
