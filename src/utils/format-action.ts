/** Format a tool/command action into a clean one-liner. */
export function formatAction(action: string, detail?: string): string | null {
  const a = action.trim().toLowerCase();

  if (a === 'read' && detail) return `▸ read ${shortPath(detail)}`;
  if (a === 'write' && detail) return `▸ write ${shortPath(detail)}`;
  if (a === 'edit' && detail) return `▸ edit ${shortPath(detail)}`;
  if (a === 'glob' && detail) return `▸ search ${detail}`;
  if (a === 'grep' && detail) return `▸ grep ${detail.slice(0, 40)}`;
  if (a === 'bash' && detail) return `▸ ${cleanCommand(detail)}`;
  if (a === 'file_change' && detail) return `▸ write ${shortPath(detail)}`;
  if (a === 'list_directory' && detail) return `▸ list ${shortPath(detail)}`;
  if (a === 'read_file' && detail) return `▸ read ${shortPath(detail)}`;
  if (a === 'write_file' && detail) return `▸ write ${shortPath(detail)}`;
  if (a === 'create_file' && detail) return `▸ create ${shortPath(detail)}`;

  if (detail?.startsWith('$') || detail?.startsWith('/bin/')) {
    return `▸ ${cleanCommand(detail)}`;
  }

  if (action) return `▸ ${action}`;
  return null;
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return parts.join('/');
  return parts.slice(-3).join('/');
}

function cleanCommand(cmd: string): string {
  let c = cmd.trim();
  c = c.replace(/^\/bin\/bash\s+-lc\s+['"]?/, '').replace(/['"]?\s*$/, '');
  c = c.replace(/^\$\s*/, '');
  // Strip leading cd '...' && or cd "..." && (Codex wraps every command with cd)
  c = c.replace(/^cd\s+['"][^'"]*['"]\s*&&\s*/, '');
  c = c.replace(/^cd\s+\S+\s*&&\s*/, '');
  c = c.trim();

  if (/^(ls|find|tree|du)\b/.test(c)) return 'scanning directory';
  if (/^(rg|grep|ag)\s+--files/.test(c)) return 'listing files';
  if (/^(rg|grep|ag)\b/.test(c)) return 'searching code';
  if (/^(cat|sed|head|tail|nl)\b/.test(c)) {
    const m = c.match(/['"]?\s*(\S+\.\w+)/);
    return m ? `reading ${shortPath(m[1])}` : 'reading file';
  }
  if (/^(npm|yarn|pnpm|bun)\s+(install|i)\b/.test(c)) return 'installing deps';
  if (/^(npm|yarn|pnpm|bun)\s+(run|test|build)\b/.test(c)) {
    const m = c.match(/\b(run|test|build)\s+(\S+)/);
    return m ? m[2] : 'running script';
  }
  if (/^(npm|yarn)\s+test/.test(c)) return 'running tests';
  if (/^npx\s+tsc\b/.test(c)) return 'typechecking';
  if (/^git\b/.test(c)) return `git ${c.slice(4, 30).trim()}`;
  if (/^(mkdir|cp|mv|rm)\b/.test(c)) return 'file operation';
  if (/^(curl|wget)\b/.test(c)) return 'fetching url';
  if (/^pwd/.test(c)) return 'checking dir';
  if (/^wc\b/.test(c)) return 'counting';
  if (/^printf\b/.test(c)) return 'reading files';
  if (/^sed\b/.test(c)) return 'editing file';

  return c.length > 40 ? c.slice(0, 37) + '...' : c;
}
