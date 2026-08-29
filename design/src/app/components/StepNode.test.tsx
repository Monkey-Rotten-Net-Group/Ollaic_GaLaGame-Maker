import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StepNode } from './StepNode';

const AGENT_EXECUTOR = { type: 'agent' } as const;

vi.mock('reactflow', () => ({
  Handle: ({ type, position, isConnectable, ...props }: Record<string, unknown>) => (
    <div
      data-testid={`${type}-handle`}
      data-position={position}
      data-connectable={String(isConnectable)}
      {...props}
    />
  ),
  Position: { Top: 'top', Bottom: 'bottom' },
}));

describe('StepNode', () => {
  it('presents the step hierarchy and named connection targets', () => {
    render(<StepNode data={{ id: 'outline', kind: 'outline', executor: AGENT_EXECUTOR, status: 'pending', attempt: 0, summary: '三章结构与共同路线' }} />);

    expect(screen.getByRole('group', { name: 'outline 节点，章节大纲，待运行，未尝试' })).toBeInTheDocument();
    expect(screen.getByText('章节大纲')).toBeInTheDocument();
    expect(screen.getByText('待运行')).toBeInTheDocument();
    expect(screen.getByText('三章结构与共同路线')).toBeInTheDocument();
    expect(screen.getByLabelText('outline 输入连接点')).toHaveAttribute('data-position', 'top');
    expect(screen.getByLabelText('outline 输出连接点')).toHaveAttribute('data-position', 'bottom');
    expect(screen.getByLabelText('outline 步骤进度')).toHaveAttribute('aria-valuenow', '0');
  });

  it('keeps selected, running, attempt, and indeterminate progress states distinct', () => {
    render(
      <StepNode
        selected
        data={{ id: 'scene-01', kind: 'scene', executor: AGENT_EXECUTOR, status: 'running', attempt: 2 }}
      />,
    );

    const node = screen.getByRole('group', { name: 'scene-01 节点，场景编排，运行中，尝试 2' });
    expect(node).toHaveAttribute('data-selected', 'true');
    expect(node).toHaveClass('ring-2', 'border-primary/70');
    expect(screen.getByText('尝试 2')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByLabelText('scene-01 步骤进度')).not.toHaveAttribute('aria-valuenow');
  });

  it('clamps explicit progress and retains the failure treatment', () => {
    render(
      <StepNode
        data={{ id: 'review', kind: 'review', executor: AGENT_EXECUTOR, status: 'failed', attempt: 3, progress: 125, selected: true }}
        isConnectable={false}
      />,
    );

    const node = screen.getByRole('group', { name: 'review 节点，质量审阅，失败，尝试 3' });
    expect(node).toHaveClass('ring-2', 'border-destructive/70', 'bg-destructive/5');
    expect(screen.getByLabelText('review 步骤进度')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByTestId('target-handle')).toHaveAttribute('data-connectable', 'false');
    expect(screen.getByTestId('source-handle')).toHaveAttribute('data-connectable', 'false');
  });

  it('keeps a downgraded success visibly distinct from a trusted success', () => {
    render(<StepNode data={{ id: 'dialogist', kind: 'scene', executor: AGENT_EXECUTOR, status: 'succeeded', attempt: 1, downgraded: true }} />);
    const node = screen.getByRole('group', { name: 'dialogist 节点，场景编排，已降级，尝试 1' });
    expect(node).toHaveAttribute('data-downgraded', 'true');
    expect(node).toHaveClass('border-amber-600/60');
    expect(screen.getByText('已降级')).toBeInTheDocument();
  });
});
