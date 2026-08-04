import { describe, it, expect, vi } from 'vitest';
import { resolveDispatchMode } from './dispatch-mode.js';

describe('resolveDispatchMode', () => {
  it('passes through a configured sandbox mode without warning', () => {
    const warn = vi.fn();

    const mode = resolveDispatchMode('sandbox', { warn });

    expect(mode).toBe('sandbox');
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes through a configured graph mode without warning', () => {
    const warn = vi.fn();

    const mode = resolveDispatchMode('graph', { warn });

    expect(mode).toBe('graph');
    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults to sandbox and warns when the setting is absent', () => {
    const warn = vi.fn();

    const mode = resolveDispatchMode(undefined, { warn });

    expect(mode).toBe('sandbox');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('defaults to sandbox and warns when the setting is an empty string', () => {
    const warn = vi.fn();

    const mode = resolveDispatchMode('', { warn });

    expect(mode).toBe('sandbox');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('defaults to sandbox and warns when the setting is whitespace-only', () => {
    const warn = vi.fn();

    const mode = resolveDispatchMode('   ', { warn });

    expect(mode).toBe('sandbox');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('throws on an unrecognised value instead of falling back silently', () => {
    const warn = vi.fn();

    expect(() => resolveDispatchMode('production', { warn })).toThrow(/production/);
    expect(warn).not.toHaveBeenCalled();
  });
});
