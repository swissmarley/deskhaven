// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../src/state/store.js';
import { INFO_NOTICE_MS, Notices } from '../src/ui/Notices.js';

describe('Notices', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ notices: [] });
    vi.useRealTimers();
  });

  it('dismisses a toast only from its × button, not from a click on its text', () => {
    render(<Notices />);
    act(() => useAppStore.getState().pushNotice('error', 'Merge preview failed'));
    fireEvent.click(screen.getByText('Merge preview failed'));
    expect(useAppStore.getState().notices).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(useAppStore.getState().notices).toHaveLength(0);
  });

  it('lets info toasts expire and keeps errors until dismissed', () => {
    vi.useFakeTimers();
    render(<Notices />);
    act(() => {
      useAppStore.getState().pushNotice('info', 'Git commands copied.');
      useAppStore.getState().pushNotice('error', 'Authentication failed');
    });
    act(() => {
      vi.advanceTimersByTime(INFO_NOTICE_MS);
    });
    expect(useAppStore.getState().notices.map((n) => n.message)).toEqual(['Authentication failed']);
  });

  it('lets clicks pass through the toast stack to the modal underneath', () => {
    const css = fs.readFileSync(path.join(import.meta.dirname, '../src/styles.css'), 'utf8');
    const block = (selector: string) =>
      css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
    expect(block('.notices')).toMatch(/pointer-events:\s*none/);
    expect(block('.notice-dismiss')).toMatch(/pointer-events:\s*auto/);
  });
});
