import { Activity } from 'lucide-react';
import type { PipelineEvent, PipelineEventRecord, StepDef } from '../lib/pipeline-types';
import { cn } from './ui/utils';

export type { PipelineEventRecord } from '../lib/pipeline-types';

export interface PipelineEventLedgerProps {
  events: readonly PipelineEventRecord[];
  steps?: readonly Pick<StepDef, 'id' | 'kind'>[];
}

const KIND_LABEL: Record<StepDef['kind'], string> = {
  plan: '策划',
  memory: '记忆',
  outline: '大纲',
  character: '角色',
  scene: '场景',
  asset: '素材',
  lint: '检查',
  review: '审阅',
  export: '导出',
  userInput: '用户输入',
};

type EventTone = 'active' | 'success' | 'warning' | 'error' | 'neutral';

const TONE_CLASS: Record<EventTone, string> = {
  active: 'border-l-blue-500',
  success: 'border-l-emerald-500',
  warning: 'border-l-amber-500',
  error: 'border-l-destructive',
  neutral: 'border-l-muted-foreground/45',
};

function eventDescription(event: PipelineEvent): { text: string; tone: EventTone } {
  switch (event.type) {
    case 'runStarted':
      return { text: '生产流程已启动', tone: 'active' };
    case 'stepStarted':
      return { text: '开始执行', tone: 'active' };
    case 'stepSucceeded':
      return { text: '执行完成', tone: 'success' };
    case 'stepFailed':
      return { text: `执行失败：${event.error}`, tone: 'error' };
    case 'stepSkipped':
      return { text: '已跳过', tone: 'neutral' };
    case 'runPaused':
      return { text: '生产流程已暂停', tone: 'warning' };
    case 'runResumed':
      return { text: '生产流程继续执行', tone: 'active' };
    case 'runStopped':
      return { text: '生产流程已停止', tone: 'warning' };
    case 'runCompleted':
      return { text: '生产流程已完成', tone: 'success' };
    case 'runFailed':
      return { text: `生产流程失败：${event.error}`, tone: 'error' };
    case 'runTimedOut':
      return { text: `生产流程已超时：${event.error}`, tone: 'error' };
    case 'runPersistenceFailed':
      return { text: `流程状态保存失败：${event.error}`, tone: 'error' };
  }
}

function eventTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function PipelineEventLedger({ events, steps = [] }: PipelineEventLedgerProps) {
  const ordered = events
    .map((record, index) => ({ ...record, index }))
    .sort((left, right) => left.receivedAt - right.receivedAt || left.index - right.index);
  const stepKinds = new Map<string, string>(steps.map((step) => [step.id, KIND_LABEL[step.kind]]));

  return (
    <section aria-label="生产事件账本" className="flex h-full min-h-0 flex-col bg-surface-container-lowest">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface-container-low px-3">
        <Activity className="size-3.5 text-primary" aria-hidden="true" />
        <h2 className="text-xs font-semibold">生产事件</h2>
        <span className="ml-auto font-mono-family text-[10px] text-muted-foreground">
          {events.length} 条
        </span>
      </header>

      {ordered.length ? (
        <ol
          aria-label="生产事件"
          aria-live="polite"
          aria-relevant="additions text"
          className="min-h-0 flex-1 divide-y divide-border/70 overflow-y-auto"
        >
          {ordered.map(({ event, receivedAt, index }) => {
            if (event.type === 'stepStarted') stepKinds.set(event.stepId, KIND_LABEL[event.kind as StepDef['kind']] ?? event.kind);
            const stepId = 'stepId' in event ? event.stepId : null;
            const description = eventDescription(event);

            return (
              <li
                key={`${receivedAt}-${index}-${event.type}`}
                className={cn(
                  'grid min-h-8 grid-cols-[4.75rem_minmax(5.5rem,8rem)_minmax(0,1fr)] items-center gap-2 border-l-2 px-3 py-1.5 text-xs',
                  TONE_CLASS[description.tone],
                )}
              >
                <time dateTime={new Date(receivedAt).toISOString()} className="font-mono-family text-[10px] text-muted-foreground">
                  {eventTime(receivedAt)}
                </time>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <strong className="truncate font-mono-family text-[11px] font-semibold text-foreground">
                    {stepId ?? 'RUN'}
                  </strong>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {stepId ? (stepKinds.get(stepId) ?? '步骤') : '流程'}
                  </span>
                </span>
                <span className={cn('min-w-0 truncate text-foreground/80', description.tone === 'error' && 'text-destructive')} title={description.text}>
                  {description.text}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <div role="status" aria-live="polite" className="flex min-h-20 flex-1 items-center justify-center px-4 text-xs text-muted-foreground">
          流程开始后，事件会记录在这里
        </div>
      )}
    </section>
  );
}
