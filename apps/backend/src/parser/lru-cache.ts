/**
 * 简单 Map 版 LRU/有界缓存（Python OrderedDict 的等价物）。
 *
 * - touchOnGet=true：读命中时移到最新（torrent_parser 的
 *   ``move_to_end`` 语义，真 LRU）；
 * - touchOnGet=false：读命中不动位置，仅写入超限时淘汰最旧
 *   （tmdb_parser / mikan_parser 的插入序有界字典语义）。
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    private readonly maxSize: number,
    private readonly touchOnGet: boolean = true,
  ) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    if (this.touchOnGet) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
