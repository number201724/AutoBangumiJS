/**
 * TitleParser 门面 —— 1:1 移植 module/parser/title_parser.py。
 *
 * 确定性解析 → classic 旧契约投影 → LLM primary/fallback 合并 → 准入 →
 * Bangumi/Movie；LLM 懒单例（配置 + auth_generation 作缓存键）、TTL 缓存、
 * 并发信号量、熔断器（连续失败 N 次暂停 M 秒）、AuthExpiredError 熔断。
 */
import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';

import { llmEffective, type ParsedConfig } from '../config/config.schema';
import { settings } from '../config/settings';
import { LLMParser } from './llm';
import { mikanParser as mikanParserFn } from './mikan-parser';
import {
  PersistenceTarget,
  bangumiEpisodeType,
  isWeakTitleOnly,
  normalizedSeason,
  persistenceTarget,
} from './release-policy';
import { parseConfiguredReleaseTitleWithTrace } from './selector';
import { tmdbParser as tmdbParserFn } from './tmdb-parser';
import { torrentParser as torrentParserFn } from './torrent-parser';
import type { Claims } from './tokenizer/candidate';
import { toLegacyEpisode } from './tokenizer/compat';
import {
  MediaType,
  ReleaseKind,
  makeEpisode,
  makeParsedRelease,
  primaryTitle,
  type Bangumi,
  type Episode,
  type EpisodeFile,
  type Movie,
  type ParsedRelease,
  type SubtitleFile,
} from './types';
import { AuthExpiredError } from './providers/base';
import { authGeneration } from './providers/credentials';
import { UnknownProviderError } from './providers/registry';
import { episodeFromDictLoose } from './providers/schema';

/** Python KeyError（titles[language] 未知语言键）——不被 rawParser 的
 * (ValueError, AttributeError, TypeError) 捕获清单吞掉，外传播。 */
export class LanguageKeyError extends Error {
  constructor(language: string) {
    super(`KeyError: '${language}'`);
    this.name = 'LanguageKeyError';
  }
}

/** pydantic v2 int 强转（lax）：整值数字/数字字符串可过，其余拒（Bangumi 构造语义） */
function coercePydanticInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

/** pydantic int 对整值浮点也可过（int_from_float）；保留小数（dataclass 容忍） */
function coercePydanticNumber(v: unknown): number | null {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  return null;
}

/** Optional[str] 语义：null/string 通过，其它转字符串（保底不炸） */
function optStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

const logger = new Logger('TitleParser');

type LlmConfig = ParsedConfig['llm'];

/** Python time.monotonic()（秒）。 */
function monotonic(): number {
  return performance.now() / 1000;
}

/** 凭据失效时向通知中心投递事件（fire-and-forget，不阻塞解析路径）。
 *  TS 里程碑：notification 子系统不在本次移植范围内，降级为日志告警；
 *  通知中心就绪后这里应改投 LLMAuthFailureEvent。 */
function notifyAuthFailure(providerId: string, message: string): void {
  logger.warn(`LLM credentials for '${providerId}' expired: ${message}`);
}

// Lazy singleton: building an LLMParser (and its underlying SDK client) is not
// free, so keep one around and only rebuild it when the relevant settings change.
// mode 不影响客户端构建（调用时读取），不参与缓存键。
let llmParserSingleton: LLMParser | null = null;
let llmParserKwargsJson: string | null = null;
const llmCache = new Map<string, [number, Episode | null]>();
let llmFailureCount = 0;
let llmBreakerUntil = 0.0;
let llmSemaphore: Semaphore | null = null;
let llmSemaphoreLimit: number | null = null;

/** 极简异步信号量（Python asyncio.Semaphore 的等价物）。 */
class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
    } else {
      this.permits += 1;
    }
  }
}

/** asyncio.wait_for：超时 reject（原 promise 继续在后台完成，
 *  axios 请求不取消——与 Python 的 task 取消语义略有差异，见移植报告）。 */
function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TimeoutError: LLM parse exceeded ${seconds}s`));
    }, seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface LlmParserKwargs {
  provider: string;
  api_key: string;
  model: string;
  base_url: string;
  timeout: number;
  /** 换号/断开时 bump → 单例重建；静默刷新不 bump（token 不进键）。 */
  auth_gen: number;
}

function kwargsCacheKey(kwargs: LlmParserKwargs, raw: string): string {
  const sorted = Object.entries(kwargs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([sorted, raw]);
}

function getLlmParser(kwargs: LlmParserKwargs): LLMParser {
  const kwargsJson = JSON.stringify(
    Object.entries(kwargs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  if (llmParserSingleton === null || llmParserKwargsJson !== kwargsJson) {
    // auth_gen 只参与"是否重建"的比较，不是构造参数
    llmParserSingleton = new LLMParser(
      kwargs.api_key,
      kwargs.provider,
      kwargs.model,
      kwargs.base_url,
      kwargs.timeout,
    );
    llmParserKwargsJson = kwargsJson;
  }
  return llmParserSingleton;
}

/**
 * 清空 LLM 解析器单例。配置重载后必须调用，否则会继续使用旧配置
 * （如 provider/base_url/api_key）构建的客户端。
 * （axios 客户端无需显式关闭，Python 的宽限期 aclose 调度在此为空操作。）
 */
export function resetCache(): void {
  llmParserSingleton = null;
  llmParserKwargsJson = null;
  llmCache.clear();
  llmFailureCount = 0;
  llmBreakerUntil = 0.0;
  llmSemaphore = null;
  llmSemaphoreLimit = null;
}

/**
 * 读取 LLM 配置段。Python 在 llm 段缺失时回退读取旧的 experimental_openai
 * （与配置的自动迁移互为保险）；TS 端 zod schema 保证 llm 段恒存在，
 * 迁移在 settings 层完成，这里直接返回。
 */
function llmConfig(): LlmConfig {
  return settings.data.llm;
}

/**
 * 用 LLM 解析标题，返回 Episode；任何失败（API 错误、拒答、
 * 输出不可用）都返回 null，由调用方决定是否回退。
 */
async function llmParse(raw: string): Promise<Episode | null> {
  const conf = llmConfig();
  const now = monotonic();
  if (llmBreakerUntil > now) {
    logger.warn(`LLM parser breaker is open; skipping '${raw}'`);
    return null;
  }
  const [apiKey, model, baseUrl] = llmEffective(conf);
  const parserKwargs: LlmParserKwargs = {
    provider: conf.provider,
    api_key: apiKey,
    model,
    base_url: baseUrl,
    timeout: conf.timeout,
    auth_gen: authGeneration(conf.provider),
  };
  const cacheKey = kwargsCacheKey(parserKwargs, raw);
  if (conf.cache_ttl > 0) {
    const cached = llmCache.get(cacheKey);
    if (cached !== undefined) {
      const [expiresAt, cachedEpisode] = cached;
      if (expiresAt > now) {
        return cachedEpisode;
      }
      llmCache.delete(cacheKey);
    }
  }
  try {
    let llm: LLMParser;
    try {
      llm = getLlmParser(parserKwargs);
    } catch (e) {
      if (e instanceof UnknownProviderError || (e instanceof Error && e.message === 'API key is required.')) {
        // 未知 provider id（如配置里手改出拼写错误）：明确指出并熔断，
        // 避免每个标题都刷一行含糊的失败日志。
        logger.error(
          `Unknown LLM provider '${conf.provider}' (${e}); check settings.llm.provider`,
        );
        llmBreakerUntil = monotonic() + conf.failure_backoff;
        cacheLlmResult(cacheKey, null, conf.cache_ttl);
        return null;
      }
      throw e;
    }
    const semaphore = getLlmSemaphore(conf.max_concurrency);
    let episodeDict: Record<string, unknown> | null;
    await semaphore.acquire();
    try {
      episodeDict = await withTimeout(llm.parse(raw, true), conf.timeout);
    } finally {
      semaphore.release();
    }
    if (episodeDict === null || typeof episodeDict !== 'object') {
      recordLlmFailure(conf);
      cacheLlmResult(cacheKey, null, conf.cache_ttl);
      return null;
    }
    const llmEpisode = episodeFromDictLoose(episodeDict);
    if (llmEpisode === null) {
      // Python ``Episode(**episode_dict)`` 的 TypeError 分支（发生在
      // _llm_parse 的异常路径——计入熔断并缓存失败）
      logger.warn(`LLM cannot parse '${raw}': TypeError: invalid episode dict`);
      recordLlmFailure(conf);
      cacheLlmResult(cacheKey, null, conf.cache_ttl);
      return null;
    }
    // Python 的 Bangumi(...) 构造校验（pydantic 强转）——发生在 raw_parser
    // 的 catch，返回 None 但**不计熔断**
    const season = coercePydanticInt(llmEpisode.season);
    const episodeNum = coercePydanticNumber(llmEpisode.episode);
    if (season === null || episodeNum === null) {
      logger.warn(
        `LLM cannot parse '${raw}': ValidationError: invalid season/episode values`,
      );
      return null;
    }
    const episode = makeEpisode({
      title_en: optStr(llmEpisode.title_en),
      title_zh: optStr(llmEpisode.title_zh),
      title_jp: optStr(llmEpisode.title_jp),
      season,
      season_raw: String(llmEpisode.season_raw ?? ''),
      episode: episodeNum,
      sub: optStr(llmEpisode.sub),
      group: String(llmEpisode.group ?? ''),
      resolution: optStr(llmEpisode.resolution),
      source: optStr(llmEpisode.source),
      episode_type: 'episode',
    });
    llmFailureCount = 0;
    llmBreakerUntil = 0.0;
    cacheLlmResult(cacheKey, episode, conf.cache_ttl);
    return episode;
  } catch (e) {
    if (e instanceof AuthExpiredError) {
      // 刷新已失败，重试没有意义：跳过失败阈值直接熔断，等用户重连。
      logger.error(
        `LLM credentials for '${conf.provider}' expired and refresh failed: ${e}`,
      );
      llmBreakerUntil = monotonic() + conf.failure_backoff;
      cacheLlmResult(cacheKey, null, conf.cache_ttl);
      notifyAuthFailure(conf.provider, String(e));
      return null;
    }
    logger.warn(`LLM cannot parse '${raw}': ${(e as Error).name}: ${(e as Error).message}`);
    recordLlmFailure(conf);
    cacheLlmResult(cacheKey, null, conf.cache_ttl);
    return null;
  }
}

function getLlmSemaphore(limit: number): Semaphore {
  if (llmSemaphore === null || llmSemaphoreLimit !== limit) {
    llmSemaphore = new Semaphore(limit);
    llmSemaphoreLimit = limit;
  }
  return llmSemaphore;
}

function cacheLlmResult(cacheKey: string, episode: Episode | null, cacheTtl: number): void {
  if (cacheTtl <= 0) {
    return;
  }
  llmCache.set(cacheKey, [monotonic() + cacheTtl, episode]);
}

function recordLlmFailure(conf: LlmConfig): void {
  llmFailureCount += 1;
  if (llmFailureCount >= conf.failure_threshold) {
    llmBreakerUntil = monotonic() + conf.failure_backoff;
  }
}

function llmMediaType(episode: Episode): MediaType {
  if (episode.episode_type === 'movie' || episode.is_movie) {
    return MediaType.MOVIE;
  }
  if (episode.episode_type === 'special') {
    return MediaType.SPECIAL;
  }
  return MediaType.EPISODE;
}

/** Apply the pre-refactor compatibility contract to a Classic result. */
function projectClassicRelease(raw: string, release: ParsedRelease | null): ParsedRelease | null {
  if (release === null) {
    return null;
  }
  const episode = toLegacyEpisode(release);
  if (episode === null) {
    return null;
  }
  return makeParsedRelease({
    raw,
    title_en: episode.title_en,
    title_zh: episode.title_zh,
    title_jp: episode.title_jp,
    group: episode.group,
    season: episode.season,
    season_raw: episode.season_raw,
    episode: episode.episode,
    media_type: llmMediaType(episode),
    resolution: episode.resolution,
    source: episode.source,
    subtitle: episode.sub,
  });
}

/** Whether a title-less parse still identified a concrete resource kind. */
function hasStructuredReleaseClaims(claims: Claims): boolean {
  return [
    claims.season,
    claims.episode,
    claims.episode_end,
    claims.media_type,
    claims.release_kind,
  ].some((value) => value !== null);
}

/**
 * Convert an LLM result without mutating the cached legacy object.
 *
 * LLM titles keep their primary-mode semantics.  When deterministic parsing
 * found a structural bundle, its media/cardinality/season/episode/version
 * fields stay atomic so an LLM cannot create hybrids such as RANGE 7-12 or
 * turn a movie/PV into a weekly episode.
 */
function mergeLlmRelease(
  raw: string,
  episode: Episode,
  deterministic: ParsedRelease | null,
): ParsedRelease {
  let mediaType = llmMediaType(episode);
  let releaseKind = ReleaseKind.SINGLE;
  let useDeterministicStructure = false;
  if (deterministic !== null) {
    if (deterministic.media_type !== MediaType.UNKNOWN || deterministic.is_mixed_collection) {
      mediaType = deterministic.media_type;
    }
    releaseKind = deterministic.release_kind;
    useDeterministicStructure = Boolean(
      deterministic.media_type !== MediaType.UNKNOWN ||
        deterministic.release_kind !== ReleaseKind.SINGLE ||
        deterministic.season !== null ||
        deterministic.episode !== null ||
        deterministic.episode_end !== null,
    );
  }

  let season: number | null = episode.season;
  let seasonRaw: string | null = episode.season_raw;
  let episodeNumber: number | null = episode.episode;
  let episodeEnd: number | null = null;
  let episodeTitle: string | null = null;
  let version: number | null = null;
  if (deterministic !== null && useDeterministicStructure) {
    season = deterministic.season;
    seasonRaw = deterministic.season_raw;
    episodeNumber = deterministic.episode;
    episodeEnd = deterministic.episode_end;
    episodeTitle = deterministic.episode_title;
    version = deterministic.version;
  }

  return makeParsedRelease({
    raw,
    title_en: episode.title_en || (deterministic ? deterministic.title_en : null),
    title_zh: episode.title_zh || (deterministic ? deterministic.title_zh : null),
    title_jp: episode.title_jp || (deterministic ? deterministic.title_jp : null),
    group: episode.group || (deterministic ? deterministic.group : null),
    season,
    season_raw: seasonRaw,
    episode: episodeNumber,
    episode_end: episodeEnd,
    episode_title: episodeTitle,
    media_type: mediaType,
    release_kind: releaseKind,
    resolution: episode.resolution || (deterministic ? deterministic.resolution : null),
    source: episode.source || (deterministic ? deterministic.source : null),
    subtitle: episode.sub || (deterministic ? deterministic.subtitle : null),
    codecs: deterministic ? deterministic.codecs : [],
    audio: deterministic ? deterministic.audio : [],
    container: deterministic ? deterministic.container : null,
    version,
    year: deterministic ? deterministic.year : null,
    tags: deterministic ? deterministic.tags : [],
    evidence: deterministic ? deterministic.evidence : [],
  });
}

/** tmdbPosterParser 的可变海报载体（Python 的 Bangumi ORM 实例）。 */
export interface PosterCarrier {
  official_title: string;
  poster_link: string | null;
}

export class TitleParser {
  static torrentParser(
    torrentPath: string,
    torrentName: string | null = null,
    season: number | null = null,
    fileType: string = 'media',
    episodeType: string = 'episode',
  ): EpisodeFile | SubtitleFile | null {
    try {
      return torrentParserFn(torrentPath, torrentName, season, fileType, episodeType);
    } catch (e) {
      logger.warn(`Cannot parse ${torrentPath} with error ${e}`);
      return null;
    }
  }

  static async tmdbParser(
    title: string,
    season: number,
    language: string,
    episodeType: string = 'episode',
  ): Promise<[string, number, string | null, string | null]> {
    const tmdbInfo = await tmdbParserFn(title, language, false, episodeType === 'movie');
    if (tmdbInfo) {
      logger.debug(`TMDB Matched, official title is ${tmdbInfo.title}`);
      const tmdbSeason = tmdbInfo.last_season ? tmdbInfo.last_season : season;
      return [tmdbInfo.title, tmdbSeason, tmdbInfo.year, tmdbInfo.poster_link];
    }
    logger.warn(`Cannot match ${title} in TMDB. Use raw title instead.`);
    logger.warn('Please change bangumi info manually.');
    return [title, season, null, null];
  }

  static async tmdbPosterParser(bangumi: PosterCarrier): Promise<void> {
    const tmdbInfo = await tmdbParserFn(
      bangumi.official_title,
      settings.data.rss_parser.language,
    );
    if (tmdbInfo) {
      logger.debug(`TMDB Matched, official title is ${tmdbInfo.title}`);
      bangumi.poster_link = tmdbInfo.poster_link;
    } else {
      logger.warn(
        `Cannot match ${bangumi.official_title} in TMDB. Use raw title instead.`,
      );
      logger.warn('Please change bangumi info manually.');
    }
  }

  /** Extract official_title and title_raw from a generic release. */
  private static resolveTitles(release: ParsedRelease): [string | null, string | null] {
    const language = settings.data.rss_parser.language;
    const titles: Record<string, string | null> = {
      zh: release.title_zh,
      // zh-tw only changes the TMDB language; release titles have a single Chinese slot.
      'zh-tw': release.title_zh,
      en: release.title_en,
      jp: release.title_jp,
    };
    // Python: titles[language] 对未知语言键抛 KeyError（不在 raw_parser 的
    // 捕获清单内 → 外传播杀掉解析任务）。language 是自由 str 配置，可触发。
    if (!(language in titles)) {
      throw new LanguageKeyError(language);
    }
    const titleRaw = release.title_en || release.title_zh || release.title_jp;
    let officialTitle: string | null;
    if (titles[language]) {
      officialTitle = titles[language];
    } else if (titles.zh) {
      officialTitle = titles.zh;
    } else if (titles.en) {
      officialTitle = titles.en;
    } else if (titles.jp) {
      officialTitle = titles.jp;
    } else {
      officialTitle = titleRaw;
    }
    return [officialTitle, titleRaw];
  }

  private static releaseToBangumi(
    release: ParsedRelease,
    officialTitle: string,
    titleRaw: string,
  ): Bangumi {
    const episode = release.episode;
    return {
      official_title: officialTitle,
      title_raw: titleRaw,
      year: release.year !== null ? String(release.year) : null,
      season: normalizedSeason(release),
      season_raw: release.season_raw,
      group_name: release.group || '',
      dpi: release.resolution,
      source: release.source,
      subtitle: release.subtitle,
      eps_collect: episode === null || episode <= 1,
      episode_offset: 0,
      filter: settings.data.rss_parser.filter.join(','),
      episode_type: bangumiEpisodeType(release),
    };
  }

  private static releaseToMovie(
    release: ParsedRelease,
    officialTitle: string,
    titleRaw: string,
  ): Movie {
    return {
      official_title: officialTitle,
      title_raw: titleRaw,
      year: release.year,
      group_name: release.group || '',
      dpi: release.resolution,
      source: release.source,
      subtitle: release.subtitle,
      filter: settings.data.rss_parser.filter.join(','),
    };
  }

  static async rawParser(raw: string): Promise<Bangumi | Movie | null> {
    try {
      const llmConf = llmConfig();
      const parseOutcome = parseConfiguredReleaseTitleWithTrace(raw);
      logger.debug(`Parsing resource with ${parseOutcome.engine} engine: ${raw}`);
      let deterministic = parseOutcome.result;
      if (parseOutcome.engine === 'classic') {
        let projected = projectClassicRelease(raw, deterministic);
        if (
          projected === null &&
          deterministic !== null &&
          deterministic.episode === null &&
          deterministic.media_type === MediaType.UNKNOWN &&
          persistenceTarget(deterministic) !== null
        ) {
          // 字幕组未标记特别篇/剧场版等字样的无集数单发资源（#1092）：
          // 旧版投影契约会整条拒绝，导致订阅静默漏抓。与 Preview 的
          // 准入策略对齐，按 eps_collect 整理集接纳；带集数的旧版
          // 拒绝（如小数集）不受影响。
          projected = deterministic;
        }
        deterministic = projected;
      }
      if (
        deterministic === null &&
        parseOutcome.trace !== null &&
        parseOutcome.trace !== undefined &&
        hasStructuredReleaseClaims(parseOutcome.trace.claims)
      ) {
        logger.debug(`Structured resource has no usable title: ${raw}`);
        return null;
      }
      if (deterministic !== null && !primaryTitle(deterministic)) {
        logger.debug(`Structured resource has no usable title: ${raw}`);
        return null;
      }
      let release: ParsedRelease | null = null;

      // primary 模式保留 LLM 标题语义，但确定性结构提示仍参与合并，
      // 避免关键词误判并确保 range/PV 等准入策略无法被绕过。
      if (llmConf.enable && llmConf.mode === 'primary') {
        const episode = await llmParse(raw);
        if (episode !== null) {
          release = mergeLlmRelease(raw, episode, deterministic);
        }
      }

      if (release === null) {
        release = deterministic;
      }

      // fallback 只处理“解析失败/只有弱标题”的输入。明确识别出的
      // PV、range、batch、collection 直接遵守业务拒绝策略。
      const shouldFallback = deterministic === null || isWeakTitleOnly(deterministic);
      if (llmConf.enable && llmConf.mode === 'fallback' && shouldFallback) {
        const episode = await llmParse(raw);
        if (episode !== null) {
          release = mergeLlmRelease(raw, episode, deterministic);
        }
      }

      if (release === null) {
        return null;
      }
      const target = persistenceTarget(release);
      if (target === null) {
        logger.debug(`Parsed but did not admit resource: ${raw}`);
        return null;
      }

      const [officialTitle, titleRaw] = TitleParser.resolveTitles(release);
      if (!titleRaw) {
        logger.warn(`Cannot extract title_raw from '${raw}', skipping`);
        return null;
      }
      if (!officialTitle) {
        logger.warn(`Cannot extract official_title from '${raw}', skipping`);
        return null;
      }
      logger.debug(`RAW:${raw} >> ${titleRaw}`);

      if (target === PersistenceTarget.MOVIE) {
        return TitleParser.releaseToMovie(release, officialTitle, titleRaw);
      }
      return TitleParser.releaseToBangumi(release, officialTitle, titleRaw);
    } catch (e) {
      // Python 的 KeyError 不在捕获清单内——外传播（杀掉解析任务）
      if (e instanceof LanguageKeyError) throw e;
      // Python 捕获 (ValueError, AttributeError, TypeError)；TS 无法区分
      // ValueError，统一兜底为同样的告警分支。
      logger.warn(`Cannot parse '${raw}': ${(e as Error).name}: ${(e as Error).message}`);
      return null;
    }
  }

  static async mikanParser(homepage: string): Promise<[string, string]> {
    return mikanParserFn(homepage);
  }
}
