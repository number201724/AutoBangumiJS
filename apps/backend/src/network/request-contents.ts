/**
 * Content-level HTTP helpers — 1:1 port of module/network/request_contents.py.
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { RequestURL } from './request-url';
import { compileUserRegex } from '../utils/pyregex';
import { parseXml, rssChannelTitle, rssParser, type XmlDoc } from './site/mikan';

const logger = new Logger('RequestContent');

/** Lightweight torrent record (mirrors the Torrent model's input shape). */
export interface TorrentData {
  name: string;
  url: string;
  homepage: string | null;
}

export class RequestContent extends RequestURL {
  async getTorrents(
    url: string,
    filter: string | null = null,
    limit?: number,
    retry = 3,
  ): Promise<TorrentData[]> {
    const soup = await this.getXml(url, retry);
    if (!soup) {
      logger.warn(`Failed to get torrents: ${url}`);
      return [];
    }
    const parsedItems = rssParser(soup);
    const effectiveFilter = filter ?? settings.data.rss_parser.filter.join('|');
    let regex: RegExp | null = null;
    // A blank filter means "exclude nothing" — re.search("", x) matches every
    // string, which would otherwise exclude everything.
    if (effectiveFilter) {
      // 按 Python re 语义编译（非法正则仍上抛对齐 re.error；语法翻译先行，
      // 因此 (?i)/(?P<>)/\w 等 Python 写法都能正确编译）
      regex = compileUserRegex(effectiveFilter);
    }
    const torrents: TorrentData[] = [];
    for (const { title, url: torrentUrl, homepage } of parsedItems) {
      if (!regex || !regex.test(title)) {
        torrents.push({ name: title, url: torrentUrl, homepage });
      }
      if (typeof limit === 'number' && torrents.length >= limit) break;
    }
    return torrents;
  }

  async getXml(url: string, retry = 3): Promise<XmlDoc | null> {
    const req = await this.getUrl(url, retry);
    if (!req) return null;
    const doc = parseXml(req.text);
    if (doc === null) {
      logger.warn(`Failed to parse XML from ${url}`);
    }
    return doc;
  }

  async getJson<T = unknown>(url: string): Promise<T | null> {
    const req = await this.getUrl(url);
    if (!req) return null;
    return req.json<T>();
  }

  /** Form-encoded POST that returns a parsed JSON response. */
  async postFormJson<T = unknown>(url: string, data: Record<string, string>): Promise<T> {
    const resp = await this.postUrl(url, data);
    return resp!.json<T>();
  }

  async postData(url: string, data: Record<string, string>) {
    return this.postUrl(url, data);
  }

  async postFiles(
    url: string,
    data: Record<string, string>,
    files: Record<string, { filename: string; content: Buffer; contentType?: string }>,
  ) {
    return this.postForm(url, data, files);
  }

  async getHtml(url: string): Promise<string | null> {
    const resp = await this.getUrl(url);
    return resp ? resp.text : null;
  }

  async getContent(url: string): Promise<Buffer | null> {
    const req = await this.getUrl(url);
    if (req) return req.content;
    logger.warn(`Failed to get content from ${url}`);
    return null;
  }

  async checkConnection(url: string): Promise<boolean> {
    return this.checkUrl(url);
  }

  async getRssTitle(url: string): Promise<string | null> {
    const soup = await this.getXml(url);
    if (soup !== null) {
      return rssChannelTitle(soup);
    }
    return null;
  }
}
