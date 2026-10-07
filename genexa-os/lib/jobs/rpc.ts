/**
 * The only door the snapshot and report jobs use into the database: call a SQL
 * function by name. In production it wraps the service-role client; in tests it
 * wraps an in-process Postgres. Throws on a database error.
 */
export type Rpc = <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<T>;

export type JobResult = { ok: boolean; summary: Record<string, unknown> };
