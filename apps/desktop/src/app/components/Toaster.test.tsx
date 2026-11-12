import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissToast, getToasts, toast } from '../lib/toast';
import { Toaster } from './Toaster';

afterEach(() => {
  for (const item of getToasts()) dismissToast(item.id);
  cleanup();
  vi.useRealTimers();
});

describe('Toaster', () => {
  it('announces success politely and dismisses it automatically', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast.success('已导出：start.txt');
    });
    expect(screen.getByRole('region', { name: '通知' })).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('已导出：start.txt')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('已导出：start.txt')).not.toBeInTheDocument();
  });

  it('keeps errors as alerts until the user closes them', async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    act(() => {
      toast.error('删除场景失败', { description: 'permission denied' });
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('删除场景失败');
    expect(alert).toHaveTextContent('permission denied');
    await user.click(screen.getByRole('button', { name: '关闭通知' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
