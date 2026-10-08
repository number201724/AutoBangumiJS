/**
 * RSS <item> extraction — 1:1 port of module/network/site/mikan.py.
 *
 * Python parses with ElementTree; we use fast-xml-parser (object mode).
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Logger } from '@nestjs/common';

const logger = new Logger('RssParser');

export interface ParsedRssItem {
  title: string;
  url: string;
  homepage: string;
}

/** Parsed XML document handle (opaque to callers, mirrors ElementTree.Element). */
export interface XmlDoc {
  root: unknown;
}

export function parseXml(xmlText: string): XmlDoc | null {
  if (XMLValidator.validate(xmlText) !== true) {
    return null;
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  return { root: parser.parse(xmlText) };
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'object') {
    const maybe = node as Record<string, unknown>;
    if ('#text' in maybe) return String(maybe['#text']);
    return '';
  }
  return String(node);
}

interface RssChannelLike {
  title?: unknown;
  item?: unknown;
}

function channelOf(doc: XmlDoc): RssChannelLike | null {
  const root = doc.root as Record<string, unknown> | null;
  const rss = root?.rss as Record<string, unknown> | undefined;
  const channel = (rss?.channel ?? root?.channel) as RssChannelLike | undefined;
  return channel ?? null;
}

/** Parse RSS items -> [title, torrent_url, homepage] triples. */
export function rssParser(doc: XmlDoc): ParsedRssItem[] {
  const channel = channelOf(doc);
  if (!channel) return [];
  const results: ParsedRssItem[] = [];
  for (const item of asArray(channel.item)) {
    try {
      const it = item as Record<string, unknown>;
      const title = textOf(it.title);
      const enclosure = it.enclosure as Record<string, unknown> | undefined;
      let url: string;
      let homepage: string;
      if (enclosure !== undefined && enclosure !== null) {
        homepage = textOf(it.link);
        url = String(enclosure['@_url'] ?? '');
      } else {
        url = textOf(it.link);
        homepage = '';
      }
      results.push({ title, url, homepage });
    } catch (e) {
      logger.warn(`Failed to parse RSS item: ${e}`);
      continue;
    }
  }
  return results;
}

export function rssChannelTitle(doc: XmlDoc): string | null {
  const channel = channelOf(doc);
  if (!channel || channel.title === undefined) return null;
  return textOf(channel.title);
}

export function mikanTitle(doc: XmlDoc): string {
  const root = doc.root as Record<string, unknown>;
  return textOf(root?.title);
}
