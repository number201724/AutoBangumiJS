/** Deterministic conflict resolution for tokenizer candidates. */

import {
  Candidate,
  ClaimField,
  Claims,
  compareCandidates,
  compareSpans,
  Decision,
  DecisionStatus,
  OverlapPolicy,
  ShadowedSpanPolicy,
  Span,
  spanKey,
} from './candidate';
import { MediaType, ReleaseKind } from '../types';
import { sub } from './regex';

/** Resolved semantic values plus the decisions that produced them. */
export class Resolution {
  constructor(
    readonly claims: Claims,
    readonly decisions: Decision[],
    readonly excludedSpans: Span[],
    readonly evidence: string[],
    readonly warnings: ResolutionWarning[] = [],
  ) {}

  get selectedCandidateIds(): string[] {
    return this.decisions
      .filter((decision) => decision.status === DecisionStatus.SELECTED)
      .map((decision) => decision.candidateId);
  }

  decisionFor(candidateId: string): Decision {
    for (const decision of this.decisions) {
      if (decision.candidateId === candidateId) return decision;
    }
    throw new Error(candidateId);
  }
}

/** Non-fatal ambiguity surfaced instead of hidden by a stable tie-break. */
export class ResolutionWarning {
  constructor(
    readonly field: ClaimField,
    readonly candidateIds: readonly [string, string],
    readonly reason: string = 'equal-rank-conflicting-claims',
  ) {}
}

function compareWarnings(a: ResolutionWarning, b: ResolutionWarning): number {
  if (a.field !== b.field) return a.field < b.field ? -1 : 1;
  for (let i = 0; i < 2; i += 1) {
    if (a.candidateIds[i] !== b.candidateIds[i]) {
      return a.candidateIds[i] < b.candidateIds[i] ? -1 : 1;
    }
  }
  if (a.reason === b.reason) return 0;
  return a.reason < b.reason ? -1 : 1;
}

function warningKey(warning: ResolutionWarning): string {
  return `${warning.field}${warning.candidateIds[0]}${warning.candidateIds[1]}${warning.reason}`;
}

/**
 * Resolve candidates without depending on their input iteration order.
 *
 * Higher priority and specificity win.  Remaining ties are settled by source
 * coordinates, rule id, and candidate id.  Rules should encode intentional
 * precedence in ``priority`` rather than relying on declaration order.
 */
export function resolveCandidates(
  candidates: Iterable<Candidate>,
  collectWarnings = true,
): Resolution {
  const ordered = [...candidates].sort(compareCandidates);
  ensureUniqueIds(ordered);

  const selected: Candidate[] = [];
  const scalarValues = new Map<ClaimField, unknown>();
  const repeatableValues = new Map<ClaimField, string[]>([
    [ClaimField.CODECS, []],
    [ClaimField.AUDIO, []],
    [ClaimField.TAGS, []],
  ]);
  const decisions: Decision[] = [];

  for (const candidate of ordered) {
    const explicitBlocker = findExplicitBlocker(candidate, selected);
    if (explicitBlocker !== null) {
      const asTitle = candidate.preserveAsTitleOnConflict;
      decisions.push(
        new Decision(
          candidate.id,
          asTitle ? DecisionStatus.REJECTED_AS_TITLE : DecisionStatus.REJECTED_CONFLICT,
          `blocked-by:${explicitBlocker.id}`,
        ),
      );
      continue;
    }

    const overlapBlocker = findOverlapBlocker(candidate, selected);
    if (overlapBlocker !== null) {
      const asTitle = candidate.preserveAsTitleOnConflict;
      decisions.push(
        new Decision(
          candidate.id,
          asTitle ? DecisionStatus.REJECTED_AS_TITLE : DecisionStatus.REJECTED_CONFLICT,
          `overlaps:${overlapBlocker.id}`,
        ),
      );
      continue;
    }

    const scalarItems = candidate.claims.scalarItems();
    const occupied = scalarItems
      .map(([field]) => field)
      .filter((field) => scalarValues.has(field));
    if (occupied.length > 0) {
      let shadowedExcludedSpans: Span[] = [];
      if (candidate.shadowedSpanPolicy === ShadowedSpanPolicy.EXCLUDE) {
        shadowedExcludedSpans =
          candidate.shadowedSpans !== null ? candidate.shadowedSpans : candidate.spans;
      }
      decisions.push(
        new Decision(
          candidate.id,
          DecisionStatus.SHADOWED,
          `shadowed-fields:${occupied.join(',')}`,
          [],
          shadowedExcludedSpans,
        ),
      );
      continue;
    }

    const wonFields: ClaimField[] = [];
    for (const [field, value] of scalarItems) {
      if (!scalarValues.has(field)) {
        scalarValues.set(field, value);
        wonFields.push(field);
      }
    }

    for (const [field, values] of candidate.claims.repeatableItems()) {
      const target = repeatableValues.get(field)!;
      const before = target.length;
      for (const value of values) {
        appendUniqueCasefold(target, value);
      }
      if (target.length > before) {
        wonFields.push(field);
      }
    }

    selected.push(candidate);
    decisions.push(
      new Decision(
        candidate.id,
        DecisionStatus.SELECTED,
        'selected',
        wonFields,
        candidate.spans,
      ),
    );
  }

  const warnings = collectWarnings ? findEqualRankConflicts(ordered, decisions) : [];
  const excludedSpans = mergeSpans(
    decisions.flatMap((decision) => decision.excludedSpans),
  );
  const evidence = collectEvidence(ordered, decisions);

  return new Resolution(
    buildClaims(scalarValues, repeatableValues),
    decisions,
    excludedSpans,
    evidence,
    warnings,
  );
}

function ensureUniqueIds(candidates: Candidate[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      throw new Error(`duplicate candidate id: ${candidate.id}`);
    }
    seen.add(candidate.id);
  }
}

function findEqualRankConflicts(
  candidates: Candidate[],
  decisions: Decision[],
): ResolutionWarning[] {
  const selectedIds = new Set(
    decisions
      .filter((decision) => decision.status === DecisionStatus.SELECTED)
      .map((decision) => decision.candidateId),
  );
  const warnings = new Map<string, ResolutionWarning>();
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i];
      const right = candidates[j];
      if (
        left.priority !== right.priority ||
        left.specificity !== right.specificity ||
        !(selectedIds.has(left.id) || selectedIds.has(right.id))
      ) {
        continue;
      }
      const leftValues = new Map(left.claims.scalarItems());
      const rightValues = new Map(right.claims.scalarItems());
      for (const field of leftValues.keys()) {
        if (!rightValues.has(field)) continue;
        if (warningValuesEqual(field, leftValues.get(field), rightValues.get(field))) {
          continue;
        }
        const [firstId, secondId] = [left.id, right.id].sort();
        const warning = new ResolutionWarning(field, [firstId, secondId]);
        warnings.set(warningKey(warning), warning);
      }
    }
  }
  return [...warnings.values()].sort(compareWarnings);
}

function warningValuesEqual(field: ClaimField, left: unknown, right: unknown): boolean {
  // ``season_raw`` records the spelling that supplied the semantic season;
  // different spellings are provenance, not contradictory values.
  if (field === ClaimField.SEASON_RAW) return true;
  if (typeof left === 'string' && typeof right === 'string') {
    let leftNormalized = left.toLowerCase();
    let rightNormalized = right.toLowerCase();
    if (field === ClaimField.SOURCE) {
      leftNormalized = sub(/[-_.\s]+/u, '', leftNormalized);
      rightNormalized = sub(/[-_.\s]+/u, '', rightNormalized);
    }
    return leftNormalized === rightNormalized;
  }
  return left === right;
}

function findExplicitBlocker(candidate: Candidate, selected: Candidate[]): Candidate | null {
  for (const winner of selected) {
    if (
      intersects(winner.blocks, candidate.conflictTags) ||
      intersects(candidate.blocks, winner.conflictTags)
    ) {
      return winner;
    }
  }
  return null;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function findOverlapBlocker(candidate: Candidate, selected: Candidate[]): Candidate | null {
  if (candidate.overlapPolicy === OverlapPolicy.SHARED) return null;
  for (const winner of selected) {
    if (winner.overlapPolicy === OverlapPolicy.SHARED) continue;
    const overlaps = candidate.spans.some((span) =>
      winner.spans.some((winnerSpan) => span.overlaps(winnerSpan)),
    );
    if (overlaps) return winner;
  }
  return null;
}

function appendUniqueCasefold(values: string[], value: string): void {
  const folded = value.toLowerCase();
  if (!values.some((existing) => existing.toLowerCase() === folded)) {
    values.push(value);
  }
}

function buildClaims(
  scalarValues: Map<ClaimField, unknown>,
  repeatableValues: Map<ClaimField, string[]>,
): Claims {
  return new Claims({
    group: scalar<string>(scalarValues, ClaimField.GROUP, 'string'),
    season: scalar<number>(scalarValues, ClaimField.SEASON, 'number'),
    season_raw: scalar<string>(scalarValues, ClaimField.SEASON_RAW, 'string'),
    episode: numberScalar(scalarValues, ClaimField.EPISODE),
    episode_end: numberScalar(scalarValues, ClaimField.EPISODE_END),
    episode_title: scalar<string>(scalarValues, ClaimField.EPISODE_TITLE, 'string'),
    media_type: mediaTypeScalar(scalarValues),
    release_kind: releaseKindScalar(scalarValues),
    resolution: scalar<string>(scalarValues, ClaimField.RESOLUTION, 'string'),
    source: scalar<string>(scalarValues, ClaimField.SOURCE, 'string'),
    subtitle: scalar<string>(scalarValues, ClaimField.SUBTITLE, 'string'),
    codecs: [...repeatableValues.get(ClaimField.CODECS)!],
    audio: [...repeatableValues.get(ClaimField.AUDIO)!],
    container: scalar<string>(scalarValues, ClaimField.CONTAINER, 'string'),
    version: scalar<number>(scalarValues, ClaimField.VERSION, 'number'),
    year: scalar<number>(scalarValues, ClaimField.YEAR, 'number'),
    tags: [...repeatableValues.get(ClaimField.TAGS)!],
  });
}

function scalar<T>(
  values: Map<ClaimField, unknown>,
  field: ClaimField,
  expected: 'string' | 'number',
): T | null {
  const value = values.get(field);
  if (value === undefined || value === null) return null;
  if (typeof value !== expected) {
    throw new TypeError(`invalid value for ${field}: ${String(value)}`);
  }
  return value as T;
}

function numberScalar(
  values: Map<ClaimField, unknown>,
  field: ClaimField,
): number | null {
  const value = values.get(field);
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number') {
    throw new TypeError(`invalid value for ${field}: ${String(value)}`);
  }
  return value;
}

function mediaTypeScalar(values: Map<ClaimField, unknown>): MediaType | null {
  const value = values.get(ClaimField.MEDIA_TYPE);
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(value in mediaTypeValues)) {
    throw new TypeError(`invalid value for media_type: ${String(value)}`);
  }
  return value as MediaType;
}

const mediaTypeValues: Record<string, true> = {
  unknown: true,
  episode: true,
  movie: true,
  ova: true,
  oad: true,
  special: true,
  pv: true,
  opening: true,
  ending: true,
};

function releaseKindScalar(values: Map<ClaimField, unknown>): ReleaseKind | null {
  const value = values.get(ClaimField.RELEASE_KIND);
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(value in releaseKindValues)) {
    throw new TypeError(`invalid value for release_kind: ${String(value)}`);
  }
  return value as ReleaseKind;
}

const releaseKindValues: Record<string, true> = {
  single: true,
  range: true,
  batch: true,
  collection: true,
};

function mergeSpans(spans: Iterable<Span>): Span[] {
  const seen = new Set<string>();
  const ordered: Span[] = [];
  for (const span of spans) {
    const key = spanKey(span);
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(span);
    }
  }
  ordered.sort(compareSpans);
  if (ordered.length === 0) return [];

  const merged: Span[] = [ordered[0]];
  for (const span of ordered.slice(1)) {
    const previous = merged[merged.length - 1];
    if (span.segment === previous.segment && span.start <= previous.end) {
      merged[merged.length - 1] = new Span(
        previous.segment,
        previous.start,
        Math.max(previous.end, span.end),
      );
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function collectEvidence(candidates: Candidate[], decisions: Decision[]): string[] {
  const evidence: string[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const decision = decisions[i];
    if (decision.status !== DecisionStatus.SELECTED) continue;
    for (const item of candidate.evidence) {
      if (!evidence.includes(item)) {
        evidence.push(item);
      }
    }
  }
  return evidence;
}
