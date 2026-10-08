/**
 * Python → JS 正则语法翻译（用户提供的过滤正则按 Python re 语义解释）。
 *
 * 处理：
 * - 行首内联 flag：(?i)/(?s)/(?m) → JS flags
 * - 命名组：(?P<name>...) → (?<name>...)
 * - Unicode 字符类：Python \w=[L+N+_]、\d=Nd（JS 即使加 u flag，\w/\d 也仅
 *   ASCII）→ Unicode property escapes，并自动追加 u flag
 */
export function pythonizeRegex(
  pattern: string,
  flags = '',
): { source: string; flags: string } {
  let src = pattern;
  let fl = flags;

  // 行首内联 flag：(?i)(?s)(?m)
  const inline = src.match(/^\(\?([ims]+)\)/);
  if (inline) {
    for (const f of inline[1]) {
      if (!fl.includes(f)) fl += f;
    }
    src = src.slice(inline[0].length);
  }

  // (?P<name>...) → (?<name>...)
  src = src.replace(/\(\?P<(\w+)>/g, '(?<$1>');

  // Python Unicode 类（负向 lookbehind 避免命中 \\w 这类转义字面量）
  src = src.replace(/(?<!\\)\\w/g, '[\\p{L}\\p{N}_]');
  src = src.replace(/(?<!\\)\\W/g, '[^\\p{L}\\p{N}_]');
  src = src.replace(/(?<!\\)\\d/g, '\\p{Nd}');
  src = src.replace(/(?<!\\)\\D/g, '[^\\p{Nd}]');

  if (!fl.includes('u')) fl += 'u';
  return { source: src, flags: fl };
}

/** 按 Python re 语义编译用户正则。 */
export function compileUserRegex(pattern: string, flags = ''): RegExp {
  const { source, flags: f } = pythonizeRegex(pattern, flags);
  return new RegExp(source, f);
}
