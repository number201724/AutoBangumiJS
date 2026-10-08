/** Immutable diagnostics for explaining release-title parser decisions. */

import {
  Candidate,
  Claims,
  compareCandidates,
  compareObservations,
  Decision,
  DecisionStatus,
  Observation,
  Span,
} from './candidate';
import { Resolution, ResolutionWarning } from './resolver';
import { ParsedRelease } from '../types';

/** Segment snapshot with explicit normalized-text coordinates. */
export class TraceSegment {
  constructor(
    readonly index: number,
    readonly text: string,
    readonly outerStart: number,
    readonly outerEnd: number,
    readonly contentStart: number,
    readonly contentEnd: number,
    readonly enclosure: string | null = null,
  ) {
    if (index < 0) throw new Error('segment index must be non-negative');
    if (!(0 <= outerStart && outerStart <= contentStart)) {
      throw new Error('invalid segment start coordinates');
    }
    if (!(contentStart <= contentEnd && contentEnd <= outerEnd)) {
      throw new Error('invalid segment end coordinates');
    }
  }
}

/** All observations and resolver decisions for one parser invocation. */
export class ParseTrace {
  readonly segments: TraceSegment[];
  readonly observations: Observation[];
  readonly candidates: Candidate[];

  constructor(
    readonly raw: string,
    readonly normalized: string,
    segments: TraceSegment[] = [],
    observations: Observation[] = [],
    candidates: Candidate[] = [],
    readonly claims: Claims = new Claims(),
    readonly decisions: Decision[] = [],
    readonly excludedSpans: Span[] = [],
    readonly residuals: string[] = [],
    readonly warnings: ResolutionWarning[] = [],
  ) {
    this.segments = [...segments].sort((a, b) => a.index - b.index);
    this.observations = [...observations].sort(compareObservations);
    this.candidates = [...candidates].sort(compareCandidates);
  }

  static fromResolution(args: {
    raw: string;
    normalized: string;
    resolution: Resolution;
    segments?: TraceSegment[];
    observations?: Observation[];
    candidates?: Candidate[];
    residuals?: string[];
  }): ParseTrace {
    const { raw, normalized, resolution } = args;
    return new ParseTrace(
      raw,
      normalized,
      args.segments ?? [],
      args.observations ?? [],
      args.candidates ?? [],
      resolution.claims,
      resolution.decisions,
      resolution.excludedSpans,
      args.residuals ?? [],
      resolution.warnings,
    );
  }

  decisionFor(candidateId: string): Decision {
    for (const decision of this.decisions) {
      if (decision.candidateId === candidateId) return decision;
    }
    throw new Error(candidateId);
  }

  get rejectedAsTitle(): string[] {
    return this.decisions
      .filter((decision) => decision.status === DecisionStatus.REJECTED_AS_TITLE)
      .map((decision) => decision.candidateId);
  }
}

/** Optional parse result paired with its complete diagnostic trace. */
export class ParseOutcome {
  constructor(
    readonly result: ParsedRelease | null,
    readonly trace: ParseTrace,
  ) {}
}
