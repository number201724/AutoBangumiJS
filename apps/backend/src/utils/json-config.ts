/**
 * JSON file helpers — 1:1 port of module/utils/json_config.py.
 */
import * as fs from 'node:fs';

export function loadJsonFile<T = unknown>(filename: string): T {
  return JSON.parse(fs.readFileSync(filename, 'utf-8')) as T;
}

export function saveJsonFile(filename: string, obj: unknown): void {
  fs.writeFileSync(filename, JSON.stringify(obj, null, 4), 'utf-8');
}
