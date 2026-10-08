/**
 * Immutable evidence and candidate models used by the title resolver.
 *
 * Regex rules should only describe what they observed.  They must not mutate the
 * parse result or remove text from the title.  Semantic candidates group one or
 * more observations into an interpretation that can be resolved deterministically.
 *
 * （镜像 candidate.py；Python frozen dataclass → TS readonly class。）
 */

import { MediaType, ReleaseKind } from '../types';

export enum ClaimField {
  GROUP = 'group',
  SEASON = 'season',
  SEASON_RAW = 'season_raw',
  EPISODE = 'episode',
  EPISODE_END = 'episode_end',
  EPISODE_TITLE = 'episode_title',
  MEDIA_TYPE = 'media_type',
  RELEASE_KIND = 'release_kind',
  RESOLUTION = 'resolution',
  SOURCE = 'source',
  SUBTITLE = 'subtitle',
  CODECS = 'codecs',
  AUDIO = 'audio',
  CONTAINER = 'container',
  VERSION = 'version',
  YEAR = 'year',
  TAGS = 'tags',
}

export enum ShadowedSpanPolicy {
  EXCLUDE = 'exclude',
  KEEP = 'keep',
}

export enum OverlapPolicy {
  EXCLUSIVE = 'exclusive',
  SHARED = 'shared',
}

export enum DecisionStatus {
  SELECTED = 'selected',
  SHADOWED = 'shadowed',
  REJECTED_AS_TITLE = 'rejected_as_title',
  REJECTED_CONFLICT = 'rejected_conflict',
}

/** Half-open character range using coordinates local to one segment. */
export class Span {
  constructor(
    readonly segment: number,
    readonly start: number,
    readonly end: number,
  ) {
    if (segment < 0) throw new Error('segment must be non-negative');
    if (start < 0) throw new Error('span start must be non-negative');
    if (end <= start) throw new Error('span end must be greater than start');
  }

  get length(): number {
    return this.end - this.start;
  }

  overlaps(other: Span): boolean {
    return (
      this.segment === other.segment &&
      this.start < other.end &&
      other.start < this.end
    );
  }

  contains(other: Span): boolean {
    return (
      this.segment === other.segment &&
      this.start <= other.start &&
      this.end >= other.end
    );
  }
}

export function spanKey(span: Span): string {
  return `${span.segment}:${span.start}:${span.end}`;
}

/** Python order=True 的 Span 排序（segment, start, end）。 */
export function compareSpans(a: Span, b: Span): number {
  if (a.segment !== b.segment) return a.segment - b.segment;
  if (a.start !== b.start) return a.start - b.start;
  return a.end - b.end;
}

/** Python tuple 比较：逐元素，前缀较短者更小。 */
export function compareSpanTuples(a: readonly Span[], b: readonly Span[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const order = compareSpans(a[i], b[i]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** Python tuple 相等（长度 + 逐元素）。 */
export function spanTuplesEqual(a: readonly Span[], b: readonly Span[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (compareSpans(a[i], b[i]) !== 0) return false;
  }
  return true;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** A direct, interpretation-free match produced by a tokenizer rule. */
export class Observation {
  readonly sortKey: readonly [number, number, number, string, string];

  constructor(
    readonly id: string,
    readonly ruleId: string,
    readonly kind: string,
    readonly span: Span,
    readonly text: string,
    readonly captures: Array<string | null> = [],
  ) {
    if (!id) throw new Error('observation id must not be empty');
    if (!ruleId) throw new Error('observation rule_id must not be empty');
    if (!kind) throw new Error('observation kind must not be empty');
    this.sortKey = [span.segment, span.start, span.end, ruleId, id];
  }
}

export function compareObservations(a: Observation, b: Observation): number {
  const numericA = a.sortKey.slice(0, 3) as [number, number, number];
  const numericB = b.sortKey.slice(0, 3) as [number, number, number];
  for (let i = 0; i < 3; i += 1) {
    if (numericA[i] !== numericB[i]) return numericA[i] - numericB[i];
  }
  const ruleOrder = compareStrings(a.sortKey[3], b.sortKey[3]);
  if (ruleOrder !== 0) return ruleOrder;
  return compareStrings(a.sortKey[4], b.sortKey[4]);
}

/**
 * Typed semantic fields proposed by a candidate.
 *
 * ``None`` means that the candidate makes no claim for a scalar field.  Empty
 * tuples likewise mean no contribution to repeatable fields.
 */
export interface ClaimsInit {
  group?: string | null;
  season?: number | null;
  season_raw?: string | null;
  episode?: number | null;
  episode_end?: number | null;
  episode_title?: string | null;
  media_type?: MediaType | null;
  release_kind?: ReleaseKind | null;
  resolution?: string | null;
  source?: string | null;
  subtitle?: string | null;
  codecs?: string[];
  audio?: string[];
  container?: string | null;
  version?: number | null;
  year?: number | null;
  tags?: string[];
}

export class Claims {
  readonly group: string | null;
  readonly season: number | null;
  readonly season_raw: string | null;
  readonly episode: number | null;
  readonly episode_end: number | null;
  readonly episode_title: string | null;
  readonly media_type: MediaType | null;
  readonly release_kind: ReleaseKind | null;
  readonly resolution: string | null;
  readonly source: string | null;
  readonly subtitle: string | null;
  readonly codecs: readonly string[];
  readonly audio: readonly string[];
  readonly container: string | null;
  readonly version: number | null;
  readonly year: number | null;
  readonly tags: readonly string[];

  constructor(init: ClaimsInit = {}) {
    this.group = init.group ?? null;
    this.season = init.season ?? null;
    this.season_raw = init.season_raw ?? null;
    this.episode = init.episode ?? null;
    this.episode_end = init.episode_end ?? null;
    this.episode_title = init.episode_title ?? null;
    this.media_type = init.media_type ?? null;
    this.release_kind = init.release_kind ?? null;
    this.resolution = init.resolution ?? null;
    this.source = init.source ?? null;
    this.subtitle = init.subtitle ?? null;
    this.codecs = init.codecs ?? [];
    this.audio = init.audio ?? [];
    this.container = init.container ?? null;
    this.version = init.version ?? null;
    this.year = init.year ?? null;
    this.tags = init.tags ?? [];
  }

  scalarItems(): Array<[ClaimField, unknown]> {
    const values: Array<[ClaimField, unknown]> = [
      [ClaimField.GROUP, this.group],
      [ClaimField.SEASON, this.season],
      [ClaimField.SEASON_RAW, this.season_raw],
      [ClaimField.EPISODE, this.episode],
      [ClaimField.EPISODE_END, this.episode_end],
      [ClaimField.EPISODE_TITLE, this.episode_title],
      [ClaimField.MEDIA_TYPE, this.media_type],
      [ClaimField.RELEASE_KIND, this.release_kind],
      [ClaimField.RESOLUTION, this.resolution],
      [ClaimField.SOURCE, this.source],
      [ClaimField.SUBTITLE, this.subtitle],
      [ClaimField.CONTAINER, this.container],
      [ClaimField.VERSION, this.version],
      [ClaimField.YEAR, this.year],
    ];
    return values.filter((pair) => pair[1] !== null);
  }

  repeatableItems(): Array<[ClaimField, readonly string[]]> {
    return [
      [ClaimField.CODECS, this.codecs],
      [ClaimField.AUDIO, this.audio],
      [ClaimField.TAGS, this.tags],
    ];
  }

  get isEmpty(): boolean {
    return (
      this.scalarItems().length === 0 &&
      !this.repeatableItems().some(([, values]) => values.length > 0)
    );
  }
}

/**
 * One semantic interpretation offered to the resolver.
 *
 * ``conflict_tags`` and ``blocks`` express cross-field incompatibilities.  A
 * strong movie marker, for example, can block the ``ambiguous_episode`` tag
 * carried by a trailing bare number without blocking an explicit SxxExx.
 */
export class Candidate {
  readonly spans: Span[];
  readonly shadowedSpans: Span[] | null;

  constructor(
    readonly id: string,
    readonly ruleId: string,
    spans: Span[],
    readonly claims: Claims = new Claims(),
    readonly priority: number = 0,
    readonly specificity: number = 0,
    readonly observationIds: string[] = [],
    readonly evidence: string[] = [],
    readonly conflictTags: ReadonlySet<string> = new Set(),
    readonly blocks: ReadonlySet<string> = new Set(),
    readonly preserveAsTitleOnConflict: boolean = false,
    readonly shadowedSpanPolicy: ShadowedSpanPolicy = ShadowedSpanPolicy.EXCLUDE,
    shadowedSpans: Span[] | null = null,
    readonly overlapPolicy: OverlapPolicy = OverlapPolicy.EXCLUSIVE,
  ) {
    if (!id) throw new Error('candidate id must not be empty');
    if (!ruleId) throw new Error('candidate rule_id must not be empty');
    this.spans = canonicalSpans(spans);
    if (shadowedSpans !== null) {
      const canonicalShadowed = canonicalSpans(shadowedSpans);
      const spanKeys = new Set(this.spans.map(spanKey));
      if (!canonicalShadowed.every((span) => spanKeys.has(spanKey(span)))) {
        throw new Error('shadowed_spans must be a subset of spans');
      }
      this.shadowedSpans = canonicalShadowed;
    } else {
      this.shadowedSpans = null;
    }
  }

  /** Stable ordering key; it never depends on collection insertion order. */
  get sortKey(): readonly [number, number, readonly Span[], string, string] {
    return [-this.priority, -this.specificity, this.spans, this.ruleId, this.id];
  }
}

function canonicalSpans(spans: readonly Span[]): Span[] {
  const seen = new Set<string>();
  const unique: Span[] = [];
  for (const span of spans) {
    const key = spanKey(span);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(span);
    }
  }
  return unique.sort(compareSpans);
}

export function compareCandidates(a: Candidate, b: Candidate): number {
  const keyA = a.sortKey;
  const keyB = b.sortKey;
  if (keyA[0] !== keyB[0]) return keyA[0] - keyB[0];
  if (keyA[1] !== keyB[1]) return keyA[1] - keyB[1];
  const spanOrder = compareSpanTuples(keyA[2], keyB[2]);
  if (spanOrder !== 0) return spanOrder;
  const ruleOrder = compareStrings(keyA[3], keyB[3]);
  if (ruleOrder !== 0) return ruleOrder;
  return compareStrings(keyA[4], keyB[4]);
}

/** Auditable outcome for one candidate. */
export class Decision {
  constructor(
    readonly candidateId: string,
    readonly status: DecisionStatus,
    readonly reason: string,
    readonly wonFields: ClaimField[] = [],
    readonly excludedSpans: Span[] = [],
  ) {}

  get excludeFromTitle(): boolean {
    return this.excludedSpans.length > 0;
  }
}
