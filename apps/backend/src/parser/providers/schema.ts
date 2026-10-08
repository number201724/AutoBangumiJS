/**
 * LLM 解析的共享输出契约：Episode 形状、JSON schema 与提示词。
 * 1:1 移植 module/parser/analyser/providers/schema.py。
 */

/** LLM 结构化输出的目标形状（与 models.bangumi.Episode 字段一致）。 */
export interface LlmEpisode {
  title_en: string | null;
  title_zh: string | null;
  title_jp: string | null;
  season: number;
  season_raw: string;
  episode: number;
  sub: string;
  group: string;
  resolution: string;
  source: string;
}

export const EPISODE_KEYS = [
  'title_en',
  'title_zh',
  'title_jp',
  'season',
  'season_raw',
  'episode',
  'sub',
  'group',
  'resolution',
  'source',
] as const;

function isOptionalString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/** pydantic lax 模式的 int 强转（int / 整数字符串 / 整值 float）。 */
function coerceInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

/**
 * dataclass 语义的宽松版（``Episode(**json_dict)``，module/models/bangumi.py
 * 的 @dataclass Episode）：**只验键**（未知键/缺必需键 → null），值原样透传。
 * Python 对 anthropic/gemini 裸 JSON 走的就是这个分支；值的规范化发生在
 * 后续 Bangumi 构造（由调用方在投影时按 pydantic 语义强转，失败同样不计
 * 熔断——见 title-parser.ts）。
 */
export interface LlmEpisodeLoose {
  title_en: unknown;
  title_zh: unknown;
  title_jp: unknown;
  season: unknown;
  season_raw: unknown;
  episode: unknown;
  sub: unknown;
  group: unknown;
  resolution: unknown;
  source: unknown;
}

export function episodeFromDictLoose(value: unknown): LlmEpisodeLoose | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const dict = value as Record<string, unknown>;
  for (const key of Object.keys(dict)) {
    if (!(EPISODE_KEYS as readonly string[]).includes(key)) {
      return null;
    }
  }
  if (!EPISODE_KEYS.every((key) => key in dict)) {
    return null;
  }
  return dict as unknown as LlmEpisodeLoose;
}

/**
 * 等价于 ``Episode(**json_dict).model_dump()``：校验并规范化 LLM 输出。
 * 字段缺失/类型错误/多余键时返回 null（Python 抛 ValidationError 的分支）。
 * 用于 openai 适配器（Python 端该路径经 pydantic 先行规范化）。
 */
export function episodeFromDict(value: unknown): LlmEpisode | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const dict = value as Record<string, unknown>;
  // Python ``Episode(**episode_dict)`` 对未知 kwarg 抛 TypeError
  for (const key of Object.keys(dict)) {
    if (!(EPISODE_KEYS as readonly string[]).includes(key)) {
      return null;
    }
  }
  if (!EPISODE_KEYS.every((key) => key in dict)) {
    return null;
  }
  if (
    !isOptionalString(dict.title_en) ||
    !isOptionalString(dict.title_zh) ||
    !isOptionalString(dict.title_jp)
  ) {
    return null;
  }
  const season = coerceInt(dict.season);
  const episode = coerceInt(dict.episode);
  if (season === null || episode === null) {
    return null;
  }
  if (
    typeof dict.season_raw !== 'string' ||
    typeof dict.sub !== 'string' ||
    typeof dict.group !== 'string' ||
    typeof dict.resolution !== 'string' ||
    typeof dict.source !== 'string'
  ) {
    return null;
  }
  return {
    title_en: dict.title_en as string | null,
    title_zh: dict.title_zh as string | null,
    title_jp: dict.title_jp as string | null,
    season,
    season_raw: dict.season_raw,
    episode,
    sub: dict.sub,
    group: dict.group,
    resolution: dict.resolution,
    source: dict.source,
  };
}

// Anthropic 结构化输出要求：所有属性均列入 required，
// additionalProperties 为 false，且不带 min/max 等约束
export const EPISODE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title_en: { type: ['string', 'null'] },
    title_zh: { type: ['string', 'null'] },
    title_jp: { type: ['string', 'null'] },
    season: { type: 'integer' },
    season_raw: { type: 'string' },
    episode: { type: 'integer' },
    sub: { type: 'string' },
    group: { type: 'string' },
    resolution: { type: 'string' },
    source: { type: 'string' },
  },
  required: [
    'title_en',
    'title_zh',
    'title_jp',
    'season',
    'season_raw',
    'episode',
    'sub',
    'group',
    'resolution',
    'source',
  ],
  additionalProperties: false,
};

export const DEFAULT_PROMPT = `You will now play the role of a super assistant.
Your task is to extract structured data from unstructured text content and output it in JSON format.
If you are unable to extract any information, please keep all fields and leave the field empty or default value like \`''\`, \`None\`.
But Do not fabricate data!
`;

// Gemini 走 response_mime_type + 提示词描述 JSON 形状（避免 SDK schema
// 类型与 mypy 冲突），因此在提示词里显式给出字段列表
export const GEMINI_JSON_INSTRUCTION =
  'Output a single JSON object with exactly these keys: ' +
  'title_en (string or null), title_zh (string or null), ' +
  'title_jp (string or null), season (integer), season_raw (string), ' +
  'episode (integer), sub (string), group (string), ' +
  'resolution (string), source (string).';
