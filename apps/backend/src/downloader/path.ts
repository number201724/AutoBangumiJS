/**
 * Save-path helpers — 1:1 port of module/downloader/path.py.
 *
 * Python 用 PureWindowsPath/PurePosixPath 兼容两种分隔符；这里手写等价的
 * path 工具（正则表示两种分隔符），不用 node:path 的 posix/win32 混用，
 * 行为逐行对齐 Python 源码。
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';

const logger = new Logger('DownloaderPath');

// module.conf.PLATFORM：Python 按 sys.platform 选择 Path 实现，
// 这里按 process.platform 做同样的运行时选择。
const IS_WINDOWS = process.platform === 'win32';

const MEDIA_SUFFIXES = new Set(['.mp4', '.mkv']);
const SUBTITLE_SUFFIXES = new Set(['.ass', '.srt']);

// Windows/qB 保留字符 + 控制字符：出现在路径片段里会被下载器拆成多级
// 目录或直接丢字（qB 静默截断），必须在拼路径前替换掉 (#721)
const ILLEGAL_PATH_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * 把单个路径片段（文件夹名或文件名，不含分隔符）里的保留字符替换为空格。
 *
 * 多余空白折叠为单个空格；Windows 不允许目录/文件名以点或空格结尾，
 * 一并去掉。幂等：对已合法的名字原样返回。
 */
export function sanitizePathFragment(name: string): string {
  const cleaned = name.replace(ILLEGAL_PATH_CHARS_RE, ' ');
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  return collapsed.replace(/[. ]+$/, '');
}

// ---------------------------------------------------------------------------
// 极简 PurePath 实现（只覆盖本模块用到的 parts / suffix / join / str 语义）
// ---------------------------------------------------------------------------

/** 拆分 Windows 路径的锚点（drive / UNC / root），返回 [anchor, rest]。 */
function splitWindowsAnchor(p: string): [string, string] {
  const s = p.replace(/\//g, '\\');
  if (/^[A-Za-z]:/.test(s)) {
    if (s.length > 2 && s[2] === '\\') return [s.slice(0, 3), s.slice(3)];
    return [s.slice(0, 2), s.slice(2)];
  }
  if (s.startsWith('\\\\')) {
    // UNC: \\server\share[\]
    const m = /^\\\\[^\\]+\\[^\\]+\\?/.exec(s);
    if (m) {
      const anchor = m[0].endsWith('\\') ? m[0] : `${m[0]}\\`;
      return [anchor, s.slice(m[0].length)];
    }
    return ['', s];
  }
  if (s.startsWith('\\')) return ['\\', s.slice(1)];
  return ['', s];
}

/**
 * PureWindowsPath.parts 等价实现：同时接受 '\' 与 '/' 分隔符（#1016）。
 * 折叠重复分隔符、去掉 '.' 段；'..' 与 PurePath 一样不做解析、原样保留。
 */
export function windowsPathParts(p: string): string[] {
  const [anchor, rest] = splitWindowsAnchor(p);
  const parts = rest.split(/\\+/).filter((seg) => seg !== '' && seg !== '.');
  return anchor ? [anchor, ...parts] : parts;
}

/** PurePosixPath.parts 等价实现。 */
export function posixPathParts(p: string): string[] {
  const anchor = p.startsWith('/') ? '/' : '';
  const parts = p.split('/').filter((seg) => seg !== '' && seg !== '.');
  return anchor ? [anchor, ...parts] : parts;
}

/** 按宿主平台选择 parts 语义（对应 path.py 里按 PLATFORM 选择 Path）。 */
function platformParts(p: string): string[] {
  return IS_WINDOWS ? windowsPathParts(p) : posixPathParts(p);
}

/** PurePath.suffix：最后一个 '.' 之后的后缀（含点）。Python 3.12+ 语义：
 * 先 lstrip('.')（dotfile 不算后缀），再取最后一个 '.'（结尾孤点也算）。 */
function pathSuffix(filePath: string): string {
  const parts = platformParts(filePath);
  const name = parts.length ? parts[parts.length - 1] : '';
  const stripped = name.replace(/^\.+/, '');
  const i = stripped.lastIndexOf('.');
  return i !== -1 ? stripped.slice(i) : '';
}

function posixJoin(args: string[]): string {
  let result = '';
  for (const a of args) {
    if (a === '') continue;
    if (a.startsWith('/') || result === '') result = a;
    else result = `${result}/${a}`;
  }
  // PurePosixPath 规范化：折叠重复分隔符、去掉 '.' 段、去尾部 '/'
  const anchor = result.startsWith('/') ? '/' : '';
  const segs = result.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.length === 0) return anchor === '/' ? '/' : '.';
  return anchor + segs.join('/');
}

function windowsJoin(args: string[]): string {
  let result = '';
  for (const raw of args) {
    if (raw === '') continue;
    const a = raw.replace(/\//g, '\\');
    if (result === '') {
      result = a;
      continue;
    }
    // 右侧带锚点（绝对路径）时丢弃之前的结果
    const [anchor] = splitWindowsAnchor(a);
    if (anchor !== '') result = a;
    else result = `${result}\\${a}`;
  }
  const [anchor, rest] = splitWindowsAnchor(result);
  const segs = rest.split(/\\+/).filter((s) => s !== '' && s !== '.');
  if (segs.length === 0) return anchor !== '' ? anchor : '.';
  const sep = anchor === '' || anchor.endsWith('\\') ? '' : '\\';
  return anchor + sep + segs.join('\\');
}

/** str(Path(*args)) 的等价物（按宿主平台选择分隔符）。 */
export function joinPath(...args: string[]): string {
  return IS_WINDOWS ? windowsJoin(args) : posixJoin(args);
}

export function checkFiles(files: Array<Record<string, unknown>>): [string[], string[]] {
  const mediaList: string[] = [];
  const subtitleList: string[] = [];
  for (const f of files) {
    const fileName = f['name'] as string;
    const suffix = pathSuffix(fileName).toLowerCase();
    if (MEDIA_SUFFIXES.has(suffix)) {
      mediaList.push(fileName);
    } else if (SUBTITLE_SUFFIXES.has(suffix)) {
      subtitleList.push(fileName);
    }
  }
  return [mediaList, subtitleList];
}

export function pathToBangumi(savePath: string, torrentName = ''): [string, number] {
  // Use PureWindowsPath regardless of the host AB runs on: it accepts
  // both "\" and "/" separators, so a qBittorrent-on-Windows save_path
  // reaching a Linux AB still splits into segments correctly (#1016).
  const saveParts = windowsPathParts(savePath);
  const downloadParts = windowsPathParts(settings.data.downloader.path);
  // Get bangumi name and season
  let bangumiName = '';
  let season = 1;
  for (const part of saveParts) {
    // re.match 只锚定开头（模式无 $），JS 侧用 ^ 但不加 $ 保持一致的匹配范围
    if (/^(?:S\d+|[Ss]eason \d+)/.test(part)) {
      season = parseInt(/\d+/.exec(part)![0], 10);
    } else if (!downloadParts.includes(part)) {
      bangumiName = part;
    }
  }
  if (!bangumiName) {
    bangumiName = torrentName;
  }
  return [bangumiName, season];
}

export function fileDepth(filePath: string): number {
  return platformParts(filePath).length;
}

export function isEp(filePath: string): boolean {
  return fileDepth(filePath) <= 2;
}

/**
 * gen_save_path / rule_name 所需的最小条目字段
 * （Bangumi | BangumiUpdate | Movie | MovieUpdate 的公共子集）。
 * Movie 类型没有 season 字段——与 Python 的 isinstance 区分相对应。
 */
export interface MediaPathData {
  official_title: string | null;
  year?: string | number | null;
  season?: number;
  season_offset?: number | null;
  episode_type?: string | null;
}

function mediaFolder(data: MediaPathData): string {
  const title = data.official_title || 'Unknown Bangumi';
  const folder = sanitizePathFragment(data.year ? `${title} (${data.year})` : title);
  if (folder) {
    return folder;
  }
  // 标题全由保留字符组成时清洗结果为空——不能让所有这类条目
  // 坍缩到同一个下载目录里
  return 'Unknown Bangumi';
}

/**
 * Generate save path for a bangumi.
 *
 * The save path uses the adjusted season number (season + season_offset)
 * so files are saved directly to the correct season folder.
 *
 * Movies use a flat "Title (Year)" layout with no season subfolder, and
 * specials/OVA/OAD land in "Season 0" (Jellyfin/Plex convention) instead of
 * being interleaved with regular episodes.
 */
export function genSavePath(data: MediaPathData): string {
  const folder = mediaFolder(data);
  const episodeType = data.episode_type ?? 'episode';
  if (typeof data.season !== 'number' || episodeType === 'movie') {
    // 电影/剧场版：Title (Year)/Title (Year).ext，不建 Season 子目录
    return joinPath(settings.data.downloader.path, folder);
  }
  // Apply season_offset to get the adjusted season number for the folder
  let adjustedSeason = data.season + (data.season_offset ?? 0);
  // 季号下限：普通剧集最小为 1——偏移到 Season 0 会被 Plex/Jellyfin 当作
  // 特别篇；只有特别篇（special）允许合法落入第 0 季
  const minSeason = episodeType === 'special' ? 0 : 1;
  if (adjustedSeason < minSeason) {
    adjustedSeason = data.season;
    logger.warn(
      `Season offset would result in invalid season for ${data.official_title}, using original season`,
    );
  }
  return joinPath(settings.data.downloader.path, folder, `Season ${adjustedSeason}`);
}

/** Generate the flat save directory used by a movie/gekijouban. */
export function genMovieSavePath(data: MediaPathData): string {
  return joinPath(settings.data.downloader.path, mediaFolder(data));
}

export function movieRuleName(data: {
  official_title: string;
  group_name?: string | null;
}): string {
  return settings.data.bangumi_manage.group_tag
    ? `[${data.group_name}] ${data.official_title}`
    : data.official_title;
}

export function ruleName(data: {
  official_title: string;
  group_name?: string | null;
  season: number;
}): string {
  return settings.data.bangumi_manage.group_tag
    ? `[${data.group_name}] ${data.official_title} S${data.season}`
    : `${data.official_title} S${data.season}`;
}
