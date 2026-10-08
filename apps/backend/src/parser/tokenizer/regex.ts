/**
 * Python `re` 语义适配层（tokenizer 内部工具）。
 *
 * JS 正则与 Python re 的三处关键差异在此抹平：
 * - re.finditer：非全局 pattern 也能连续迭代 → 统一克隆出带 'g' 的副本配
 *   matchAll（matchAll 内部会再克隆，共享 lastIndex 不会被污染）；
 * - re.fullmatch / re.match（锚定在串首）→ 克隆出 ^(?:...)$ / ^(?:...)
 *   锚定副本；
 * - re.Match.start(n)/end(n)（分组坐标）→ 克隆统一追加 'd' flag
 *   （ES2022 hasIndices），用 match.indices[n] 还原。
 *
 * 所有克隆按原 pattern 缓存（WeakMap），不会在热路径上重复构造。
 */

interface Clones {
  global?: RegExp;
  full?: RegExp;
  head?: RegExp;
  plain?: RegExp;
}

const cloneCache = new WeakMap<RegExp, Clones>();

function clonesOf(re: RegExp): Clones {
  let clones = cloneCache.get(re);
  if (clones === undefined) {
    clones = {};
    cloneCache.set(re, clones);
  }
  return clones;
}

function baseFlags(re: RegExp): string {
  return re.flags.replace(/[gd]/g, '');
}

function globalClone(re: RegExp): RegExp {
  const clones = clonesOf(re);
  if (clones.global === undefined) {
    clones.global = new RegExp(re.source, `${baseFlags(re)}gd`);
  }
  return clones.global;
}

function fullClone(re: RegExp): RegExp {
  const clones = clonesOf(re);
  if (clones.full === undefined) {
    clones.full = new RegExp(`^(?:${re.source})$`, `${baseFlags(re)}d`);
  }
  return clones.full;
}

function headClone(re: RegExp): RegExp {
  const clones = clonesOf(re);
  if (clones.head === undefined) {
    clones.head = new RegExp(`^(?:${re.source})`, `${baseFlags(re)}d`);
  }
  return clones.head;
}

function plainClone(re: RegExp): RegExp {
  const clones = clonesOf(re);
  if (clones.plain === undefined) {
    clones.plain = new RegExp(re.source, `${baseFlags(re)}d`);
  }
  return clones.plain;
}

/** re.finditer：返回全部匹配（带 indices）。 */
export function finditer(re: RegExp, text: string): RegExpExecArray[] {
  return [...text.matchAll(globalClone(re))];
}

/** re.finditer 的生成器形式（供 classic 引擎的惰性 availability 检查）。 */
export function* iterMatches(re: RegExp, text: string): Generator<RegExpExecArray> {
  yield* text.matchAll(globalClone(re));
}

/** re.fullmatch。 */
export function fullmatch(re: RegExp, text: string): RegExpExecArray | null {
  return fullClone(re).exec(text);
}

/** re.match（锚定在串首，不要求全串）。 */
export function matchStart(re: RegExp, text: string): RegExpExecArray | null {
  return headClone(re).exec(text);
}

/** re.search（非全局，从位置 0 开始，带 indices）。 */
export function search(re: RegExp, text: string): RegExpExecArray | null {
  return plainClone(re).exec(text);
}

/** re.sub（替换全部出现；repl 支持 JS 的 $1 引用语法）。 */
export function sub(re: RegExp, repl: string, text: string): string {
  return text.replace(globalClone(re), repl);
}

/** re.Match.group(n)：未参与捕获的分组返回 null（Python 的 None）。 */
export function group(match: RegExpExecArray, n: number): string | null {
  const value = match[n];
  return value === undefined ? null : value;
}

/** re.Match.group()（group 0）。 */
export function group0(match: RegExpExecArray): string {
  return match[0];
}

/** re.Match.groups()：全部捕获组，未参与为 null。 */
export function groups(match: RegExpExecArray): Array<string | null> {
  const result: Array<string | null> = [];
  for (let i = 1; i < match.length; i += 1) {
    result.push(match[i] === undefined ? null : match[i]);
  }
  return result;
}

/** re.Match.start(n)。 */
export function start(match: RegExpExecArray, n = 0): number {
  return match.indices![n][0];
}

/** re.Match.end(n)。 */
export function end(match: RegExpExecArray, n = 0): number {
  return match.indices![n][1];
}

/** Python re.split(pattern, text, maxsplit=1)：JS split 的 limit 会丢弃尾部，
 *  这里手动切一刀，保留剩余部分。 */
export function splitOnce(re: RegExp, text: string): string[] {
  const match = plainClone(re).exec(text);
  if (match === null) return [text];
  return [text.slice(0, match.index), text.slice(match.index + match[0].length)];
}
