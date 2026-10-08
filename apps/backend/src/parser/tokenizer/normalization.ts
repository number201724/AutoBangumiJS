/** Input normalization shared by the release-title parser. */

import { sub } from './regex';

const FILE_EXTENSION = /\.(mp4|mkv|avi|ass|srt|ssa|sub)$/iu;

export function normalize(raw: string): string {
  let value = raw.trim().replace(/\n/g, ' ');
  value = value.replace(/【/g, '[').replace(/】/g, ']');
  // 全角数字映射为 ASCII：Python 的 \d/int() 是 Unicode 感知（'１２' 可解析），
  // JS 的 \d 仅 ASCII——在归一化阶段抹平差异（对应 Python 的隐式行为）
  value = value.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  // Full-width slashes and parentheses are title punctuation, not structure.
  return sub(FILE_EXTENSION, '', value);
}
