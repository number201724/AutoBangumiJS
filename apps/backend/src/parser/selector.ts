/**
 * Parser engine selector — mirrors module/parser/analyser/selector.py.
 *
 * ContextVar 语义说明：Python 用 ContextVar 让 ``parser_engine_snapshot()``
 * 在一个工作流内固定引擎（跨 await 生效、子任务继承、并发任务隔离、嵌套
 * scope 复用外层已绑定引擎）。TS 端用 Node 的 AsyncLocalStorage 等价实现：
 * - ``withParserEngineSnapshot(fn)`` 对应 ``with parser_engine_snapshot():``；
 * - ``parserEngineSnapshot()`` 对应 ``_configured_engine()``（快照优先，
 *   否则读实时配置）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { settings } from '../config/settings';
import * as classic from './tokenizer/classic';
import * as preview from './tokenizer/parser';
import type { ParsedRelease } from './types';
import type { ParseTrace } from './tokenizer/trace';

export type ParserEngine = 'classic' | 'tokenizer';

const engineStorage = new AsyncLocalStorage<ParserEngine>();

/**
 * A configured parse result with diagnostics when the engine supports them.
 * （Python 的 ConfiguredParseOutcome；保留 stub 期的导出名 ParseOutcome。）
 */
export interface ParseOutcome {
  result: ParsedRelease | null;
  engine: ParserEngine;
  trace?: ParseTrace | null;
}

/** Python 命名别名。 */
export type ConfiguredParseOutcome = ParseOutcome;

/**
 * 当前生效的解析引擎：AsyncLocalStorage 快照优先，否则读
 * ``settings.data.rss_parser.engine``。非法值抛出（Python 的 ValueError）。
 */
export function parserEngineSnapshot(): ParserEngine {
  const snapshot = engineStorage.getStore();
  if (snapshot !== undefined) {
    return snapshot;
  }

  // Older in-memory Settings instances can predate the field during a live
  // reload.  Missing means the documented stable default; invalid values are
  // never silently corrected here.
  const engine = (settings.data.rss_parser.engine ?? 'classic') as string;
  if (engine !== 'classic' && engine !== 'tokenizer') {
    throw new Error(`Unsupported RSS parser engine: ${JSON.stringify(engine)}`);
  }
  return engine;
}

/**
 * 对应 Python 的 ``with parser_engine_snapshot():`` —— 在 fn 执行期间（含其
 * await 边界与派生的异步操作）固定使用当前配置的引擎；嵌套调用复用外层
 * 已绑定的引擎。
 */
export function withParserEngineSnapshot<T>(fn: (engine: ParserEngine) => T): T {
  const engine = parserEngineSnapshot();
  return engineStorage.run(engine, fn, engine);
}

/** 显式指定引擎的辅助形式（快照的底层原语）。 */
export function withParserEngine<T>(engine: ParserEngine, fn: () => T): T {
  return engineStorage.run(engine, fn);
}

/** Parse *raw* with the engine selected for this invocation. */
export function parseConfiguredReleaseTitle(raw: string): ParsedRelease | null {
  return parseConfiguredReleaseTitleOutcome(raw).result;
}

/** Parse *raw* and retain the engine selected for this invocation. */
export function parseConfiguredReleaseTitleOutcome(raw: string): ParseOutcome {
  const engine = parserEngineSnapshot();
  const result =
    engine === 'classic' ? classic.parseReleaseTitle(raw) : preview.parseReleaseTitle(raw);
  return { engine, result };
}

/** Parse *raw* and include the Preview engine's native trace when available. */
export function parseConfiguredReleaseTitleWithTrace(raw: string): ParseOutcome {
  const engine = parserEngineSnapshot();
  if (engine === 'classic') {
    return { engine, result: classic.parseReleaseTitle(raw) };
  }

  const outcome = preview.parseReleaseTitleWithTrace(raw);
  return { engine, result: outcome.result, trace: outcome.trace };
}
