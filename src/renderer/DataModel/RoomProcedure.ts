/**
 * The product-neutral procedure a room uses while scoring a game.
 *
 * This mirrors the structural `_qbtcp.procedure` contract. It deliberately does not describe a
 * named ruleset: the QBJ scoring rules and this operational procedure are separate concerns, and a
 * tournament may use the same procedure with any compatible set of scoring rules.
 */
export const roomProcedureVersion = 3;

export type ProtestCheckpointPolicy = 'none' | 'phase-boundaries' | 'strict-overtime';

export type SubstitutionPolicy = 'any-boundary' | 'breaks-timeouts-overtime';

export interface IRoomBreak {
  /** The tossup after which the break is taken. */
  afterTossup: number;
  /** Optional label shown to the scorekeeper. */
  label?: string;
}

export interface IRoomProcedure {
  version: number;
  halves: boolean;
  breaks?: IRoomBreak[];
  halfLengthMinutes?: number;
  timeoutsPerTeam: number;
  timeoutDurationSeconds?: number;
  protestCheckpoints?: ProtestCheckpointPolicy;
  substitutionPolicy?: SubstitutionPolicy;
}

const maxBreakCount = 32;
const maxBreakLabelLength = 100;
const maxHalfLengthMinutes = 240;
const maxTimeoutDurationSeconds = 3600;

export function defaultRoomProcedure(): IRoomProcedure {
  return {
    version: roomProcedureVersion,
    halves: false,
    timeoutsPerTeam: 0,
  };
}

/** Make an assignment-safe copy so stored model objects cannot be changed through a UI draft. */
export function cloneRoomProcedure(procedure: IRoomProcedure): IRoomProcedure {
  return {
    ...procedure,
    breaks: procedure.breaks?.map((roomBreak) => ({ ...roomBreak })),
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): number | undefined {
  if (!finiteNumber(value) || value < 1) return undefined;
  return Math.floor(value);
}

function nonNegativeInteger(value: unknown): number {
  if (!finiteNumber(value) || value < 0) return 0;
  return Math.floor(value);
}

function normalizeBreaks(value: unknown): IRoomBreak[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<number>();
  const normalized: IRoomBreak[] = [];
  for (const valueAtBreak of value) {
    if (typeof valueAtBreak !== 'object' || valueAtBreak === null || Array.isArray(valueAtBreak)) continue;
    const rawBreak = valueAtBreak as { afterTossup?: unknown; label?: unknown };
    const afterTossup = positiveInteger(rawBreak.afterTossup);
    if (afterTossup === undefined || seen.has(afterTossup)) continue;
    seen.add(afterTossup);
    const label = typeof rawBreak.label === 'string' ? rawBreak.label.trim().slice(0, maxBreakLabelLength) : undefined;
    normalized.push({ afterTossup, ...(label ? { label } : {}) });
  }

  normalized.sort((left, right) => left.afterTossup - right.afterTossup);
  return normalized.slice(0, maxBreakCount);
}

/**
 * Normalize data read from a YFT file or a UI editor into the v3 assignment shape.
 *
 * Missing procedure data is intentionally valid: older tournaments receive the neutral default and
 * still get an explicit procedure in any new assignment.
 */
export function normalizeRoomProcedure(value: unknown): IRoomProcedure {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaultRoomProcedure();

  const raw = value as Partial<IRoomProcedure>;
  const breaks = normalizeBreaks(raw.breaks);
  const halves = raw.halves === true || !!breaks?.length;
  const halfLengthMinutes =
    halves && finiteNumber(raw.halfLengthMinutes) && raw.halfLengthMinutes > 0
      ? Math.min(Math.floor(raw.halfLengthMinutes), maxHalfLengthMinutes)
      : undefined;
  const timeoutsPerTeam = nonNegativeInteger(raw.timeoutsPerTeam);
  const timeoutDurationSeconds =
    timeoutsPerTeam > 0 && finiteNumber(raw.timeoutDurationSeconds) && raw.timeoutDurationSeconds > 0
      ? Math.min(Math.floor(raw.timeoutDurationSeconds), maxTimeoutDurationSeconds)
      : undefined;
  const protestCheckpoints =
    raw.protestCheckpoints === 'none' ||
    raw.protestCheckpoints === 'phase-boundaries' ||
    raw.protestCheckpoints === 'strict-overtime'
      ? raw.protestCheckpoints
      : undefined;
  const substitutionPolicy =
    raw.substitutionPolicy === 'any-boundary' || raw.substitutionPolicy === 'breaks-timeouts-overtime'
      ? raw.substitutionPolicy
      : undefined;

  return {
    version: roomProcedureVersion,
    halves,
    ...(breaks?.length ? { breaks } : {}),
    ...(halfLengthMinutes !== undefined ? { halfLengthMinutes } : {}),
    timeoutsPerTeam,
    ...(timeoutDurationSeconds !== undefined ? { timeoutDurationSeconds } : {}),
    ...(protestCheckpoints ? { protestCheckpoints } : {}),
    ...(substitutionPolicy ? { substitutionPolicy } : {}),
  };
}

export function updateRoomProcedure(procedure: IRoomProcedure, patch: Partial<IRoomProcedure>): IRoomProcedure {
  return normalizeRoomProcedure({ ...cloneRoomProcedure(procedure), ...patch });
}

export function normalizeHandoffInstruction(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 2000) : undefined;
}

export function resolveRoomProcedure(
  tournamentDefault: IRoomProcedure,
  roundOverride?: IRoomProcedure,
): IRoomProcedure {
  return cloneRoomProcedure(normalizeRoomProcedure(roundOverride ?? tournamentDefault));
}

export function resolveHandoffInstruction(
  tournamentDefault: string | undefined,
  roundOverride?: string,
): string | undefined {
  return normalizeHandoffInstruction(roundOverride ?? tournamentDefault);
}
