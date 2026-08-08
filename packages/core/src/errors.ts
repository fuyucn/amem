import type { UnitId } from './domain.js';

export type ErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'PROVIDER'
  | 'RATE_LIMITED'
  | 'BUSY'
  | 'INTERNAL'
  | 'NOT_CONFIGURED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN';

export class AmemError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AmemError';
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string, id: string): AmemError =>
  new AmemError('NOT_FOUND', `${what} not found`, { id });

export const validation = (message: string, details?: Record<string, unknown>): AmemError =>
  new AmemError('VALIDATION', message, details);

export const provider = (message: string, details?: Record<string, unknown>): AmemError =>
  new AmemError('PROVIDER', message, details);

export const notConfigured = (message: string): AmemError =>
  new AmemError('NOT_CONFIGURED', message);

export const unitNotFound = (id: UnitId): AmemError => notFound('Unit', id);
