import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAction } from './format-action.js';

describe('formatAction', () => {
  it('formats read action', () => {
    assert.equal(formatAction('Read', 'src/app.ts'), '▸ read src/app.ts');
  });

  it('formats write action', () => {
    assert.equal(formatAction('Write', 'src/utils/log.ts'), '▸ write src/utils/log.ts');
  });

  it('formats edit action', () => {
    assert.equal(formatAction('Edit', 'package.json'), '▸ edit package.json');
  });

  it('formats glob as search', () => {
    assert.equal(formatAction('Glob', '**/*.ts'), '▸ search **/*.ts');
  });

  it('formats grep with truncation', () => {
    const long = 'a'.repeat(100);
    const result = formatAction('Grep', long);
    assert.ok(result!.startsWith('▸ grep'));
    assert.ok(result!.length <= 70);
  });

  it('formats bash as exec with smart command parsing', () => {
    const result = formatAction('Bash', 'npm run build');
    assert.ok(result!.includes('build'));
  });

  it('shortens long file paths', () => {
    const result = formatAction('Read', '/home/user/projects/myapp/src/components/Header.tsx');
    assert.ok(result!.includes('▸ read'));
    // Should keep only last 3 path segments
    assert.ok(result!.includes('components/Header.tsx'));
  });

  it('handles file_change as write', () => {
    assert.equal(formatAction('file_change', 'src/app.ts'), '▸ write src/app.ts');
  });

  it('handles create_file', () => {
    assert.equal(formatAction('create_file', 'new.ts'), '▸ create new.ts');
  });

  it('handles delete action', () => {
    assert.equal(formatAction('delete', 'old.ts'), '▸ delete old.ts');
  });

  it('returns null for empty input', () => {
    assert.equal(formatAction(''), null);
  });

  it('returns generic format for unknown action', () => {
    assert.equal(formatAction('CustomTool'), '▸ CustomTool');
  });

  it('is case-insensitive', () => {
    assert.equal(formatAction('READ', 'file.ts'), '▸ read file.ts');
    assert.equal(formatAction('WRITE', 'file.ts'), '▸ write file.ts');
  });

  describe('bash command cleaning', () => {
    it('detects npm install', () => {
      const result = formatAction('Bash', 'npm install express');
      assert.ok(result!.includes('installing deps'));
    });

    it('detects npm run', () => {
      const result = formatAction('Bash', 'npm run test');
      assert.ok(result!.includes('test'));
    });

    it('detects git commands', () => {
      const result = formatAction('Bash', 'git status');
      assert.ok(result!.includes('git'));
    });

    it('detects tsc', () => {
      const result = formatAction('Bash', 'npx tsc --noEmit');
      assert.ok(result!.includes('typechecking'));
    });

    it('strips cd prefix from commands', () => {
      const result = formatAction('Bash', "cd '/home/user/project' && npm run test");
      assert.ok(result!.includes('test'), `Expected 'test' in: ${result}`);
    });

    it('detects ls/find as scanning', () => {
      const result = formatAction('Bash', 'ls -la src/');
      assert.ok(result!.includes('scanning'));
    });

    it('detects grep/rg as searching', () => {
      const result = formatAction('Bash', 'rg "TODO" src/');
      assert.ok(result!.includes('searching'));
    });
  });
});
