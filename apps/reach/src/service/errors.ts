// Copyright (c) Ray Zhang.
export class ReachError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function requireCondition(value: unknown, status: number, code: string, message: string): asserts value {
  if (!value) throw new ReachError(status, code, message);
}
