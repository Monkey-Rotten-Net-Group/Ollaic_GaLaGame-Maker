import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StepDef } from '../lib/pipeline-types';
import { PipelineEventLedger, type PipelineEventRecord } from './PipelineEventLedger';

const at = (hour: number, second: number) => new Date(2026, 6, 10, hour, 5, second).getTime();

const steps: Pick<StepDef, 'id' | 'kind'>[] = [
  { id: 'plan', kind: 'plan' },
  { id: 'outline', kind: 'outline' },
];

const record = (event: PipelineEventRecord['event'], receivedAt: number): PipelineEventRecord => ({ event, receivedAt });

describe('PipelineEventLedger', () => {
  it('announces a useful empty state', () => {
    render(<PipelineEventLedger events={[]} />);

    expect(screen.getByRole('region', { name: '生产事件账本' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('流程开始后，事件会记录在这里');
    expect(screen.getByText('0 条')).toBeInTheDocument();
  });

  it('sorts events chronologically and renders localized run and step activity', () => {
    const events = [
      record({ type: 'runCompleted', runId: 'run-1' }, at(8, 10)),
      record({ type: 'stepFailed', runId: 'run-1', stepId: 'outline', error: '模型超时' }, at(8, 4)),
      record({ type: 'runStarted', runId: 'run-1' }, at(8, 1)),
      record({ type: 'stepStarted', runId: 'run-1', stepId: 'plan', kind: 'plan' }, at(8, 2)),
      record({ type: 'stepSucceeded', runId: 'run-1', stepId: 'plan', output: '{}' }, at(8, 3)),
      record({ type: 'stepSkipped', runId: 'run-1', stepId: 'outline' }, at(8, 5)),
      record({ type: 'runPaused', runId: 'run-1' }, at(8, 6)),
      record({ type: 'runResumed', runId: 'run-1' }, at(8, 7)),
      record({ type: 'runStopped', runId: 'run-1' }, at(8, 8)),
      record({ type: 'runFailed', runId: 'run-1', error: '写盘失败' }, at(8, 9)),
    ];

    render(<PipelineEventLedger events={events} steps={steps} />);

    const ledger = screen.getByRole('list', { name: '生产事件' });
    expect(ledger).toHaveAttribute('aria-live', 'polite');
    const entries = within(ledger).getAllByRole('listitem');
    expect(entries).toHaveLength(10);
    expect(entries.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining('生产流程已启动'),
      expect.stringContaining('plan策划开始执行'),
      expect.stringContaining('plan策划执行完成'),
      expect.stringContaining('outline大纲执行失败：模型超时'),
      expect.stringContaining('outline大纲已跳过'),
      expect.stringContaining('生产流程已暂停'),
      expect.stringContaining('生产流程继续执行'),
      expect.stringContaining('生产流程已停止'),
      expect.stringContaining('生产流程失败：写盘失败'),
      expect.stringContaining('生产流程已完成'),
    ]);
    expect(entries[0]).toHaveTextContent(/08:05:01/);
    expect(screen.getByText('10 条')).toBeInTheDocument();
  });

  it('learns an unknown step type from its start event', () => {
    const events = [
      record({ type: 'stepStarted', runId: 'run-1', stepId: 'export', kind: 'export' }, at(9, 1)),
      record({ type: 'stepSucceeded', runId: 'run-1', stepId: 'export', output: null }, at(9, 2)),
    ];

    render(<PipelineEventLedger events={events} />);

    expect(screen.getAllByText('导出')).toHaveLength(2);
  });

  it('distinguishes timeout and persistence failure terminal events', () => {
    render(<PipelineEventLedger events={[
      record({ type: 'runTimedOut', runId: 'run-1', error: '步骤超过 3 分钟' }, at(10, 1)),
      record({ type: 'runPersistenceFailed', runId: 'run-2', error: '磁盘空间不足，请清理后重新打开项目' }, at(10, 2)),
    ]} />);

    expect(screen.getByText('生产流程已超时：步骤超过 3 分钟')).toBeInTheDocument();
    expect(screen.getByText('流程状态保存失败：磁盘空间不足，请清理后重新打开项目')).toBeInTheDocument();
  });
});
