/**
 * Expand shell-style $VAR / ${VAR} references (mirrors os.path.expandvars usage
 * in module/models/config.py). Returns empty string for null/undefined.
 * POSIX: unknown refs are left untouched. Windows additionally expands %VAR%.
 */
export function expandEnv(value: string | null | undefined): string {
  if (!value) return '';
  let out = value.replace(/\$(\w+|\{[^}]*\})/g, (match, name: string) => {
    const varName = name.startsWith('{') ? name.slice(1, -1) : name;
    const resolved = process.env[varName];
    // Python expandvars leaves unknown refs untouched
    return resolved === undefined ? match : resolved;
  });
  if (process.platform === 'win32') {
    out = out.replace(/%(\w+)%/g, (match, name: string) => {
      const resolved = process.env[name];
      return resolved === undefined ? match : resolved;
    });
  }
  return out;
}
