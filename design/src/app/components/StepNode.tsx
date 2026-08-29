import { memo, type ComponentType } from 'react';
import {
  Check,
  Circle,
  CircleAlert,
  LoaderCircle,
  MessageSquareText,
  Minus,
  type LucideProps,
} from 'lucide-react';
import { Handle, Position } from 'reactflow';
import { cn } from './ui/utils';
import type { StepExecutor, StepStatus } from '../lib/pipeline-types';

const KIND_LABEL: Record<string, string> = {
  plan: '故事规划',
  memory: '长期记忆',
  outline: '章节大纲',
  character: '角色设计',
  scene: '场景编排',
  asset: '资产规划',
  lint: '一致性检查',
  review: '质量审阅',
  export: '作品导出',
  userInput: '人工确认',
};

interface StatusStyle {
  label: string;
  icon: ComponentType<LucideProps>;
  nodeClass: string;
  markerClass: string;
  badgeClass: string;
  progressClass: string;
}

const STATUS: Record<StepStatus, StatusStyle> = {
  pending: {
    label: '待运行',
    icon: Circle,
    nodeClass: 'border-outline-variant/70',
    markerClass: 'bg-outline-variant',
    badgeClass: 'border-outline-variant/70 bg-surface-container text-muted-foreground',
    progressClass: 'bg-outline-variant',
  },
  running: {
    label: '运行中',
    icon: LoaderCircle,
    nodeClass: 'border-primary/70 bg-primary/5',
    markerClass: 'bg-primary',
    badgeClass: 'border-primary/35 bg-primary/10 text-primary',
    progressClass: 'bg-primary',
  },
  succeeded: {
    label: '已完成',
    icon: Check,
    nodeClass: 'border-emerald-600/50',
    markerClass: 'bg-emerald-600',
    badgeClass: 'border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    progressClass: 'bg-emerald-600',
  },
  failed: {
    label: '失败',
    icon: CircleAlert,
    nodeClass: 'border-destructive/70 bg-destructive/5',
    markerClass: 'bg-destructive',
    badgeClass: 'border-destructive/35 bg-destructive/10 text-destructive',
    progressClass: 'bg-destructive',
  },
  awaitingInput: {
    label: '待输入',
    icon: MessageSquareText,
    nodeClass: 'border-amber-600/60 bg-amber-500/5',
    markerClass: 'bg-amber-500',
    badgeClass: 'border-amber-600/35 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    progressClass: 'bg-amber-500',
  },
  skipped: {
    label: '已跳过',
    icon: Minus,
    nodeClass: 'border-outline-variant/60 opacity-80',
    markerClass: 'bg-muted-foreground',
    badgeClass: 'border-outline-variant/60 bg-surface-container text-muted-foreground',
    progressClass: 'bg-muted-foreground',
  },
};

export interface StepNodeData {
  id: string;
  kind: string;
  executor: StepExecutor;
  status: StepStatus;
  attempt?: number;
  progress?: number;
  cost?: number;
  summary?: string;
  downgraded?: boolean;
  selected?: boolean;
}

interface StepNodeProps {
  data: StepNodeData;
  selected?: boolean;
  isConnectable?: boolean;
}

function defaultProgress(status: StepStatus): number | undefined {
  if (status === 'pending') return 0;
  if (status === 'succeeded' || status === 'skipped') return 100;
  return undefined;
}

function StepNodeComponent({ data, selected = false, isConnectable = true }: StepNodeProps) {
  const state = data.status === 'succeeded' && data.downgraded
    ? { ...STATUS.awaitingInput, label: '已降级', icon: CircleAlert }
    : STATUS[data.status];
  const StatusIcon = state.icon;
  const isSelected = selected || data.selected;
  const attempt = Math.max(0, Math.floor(data.attempt ?? 0));
  const explicitProgress = Number.isFinite(data.progress) ? data.progress : undefined;
  const progress = explicitProgress == null
    ? defaultProgress(data.status)
    : Math.min(100, Math.max(0, explicitProgress));
  const progressWidth = progress == null ? '42%' : `${progress}%`;
  const kindLabel = data.executor.type === 'assetQueue' ? '资产生产' : KIND_LABEL[data.kind] ?? data.kind;
  const cost = Number.isFinite(data.cost) ? Math.max(0, data.cost ?? 0) : null;

  return (
    <div
      className={cn(
        'relative h-[132px] w-[236px] overflow-visible rounded-md border bg-surface-container-lowest text-foreground transition-[border-color,background-color,box-shadow]',
        state.nodeClass,
        isSelected && 'ring-2 ring-primary/50 ring-offset-2 ring-offset-background',
      )}
      data-step-id={data.id}
      data-step-status={data.status}
      data-downgraded={data.downgraded || undefined}
      data-selected={isSelected || undefined}
      role="group"
      aria-label={`${data.id} 节点，${kindLabel}，${state.label}，${attempt ? `尝试 ${attempt}` : '未尝试'}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={isConnectable}
        className="!h-6 !w-6 !border-[7px] !border-surface-container-lowest !bg-outline transition-colors hover:!bg-primary"
        aria-label={`${data.id} 输入连接点`}
        title="输入连接点"
      />

      <span className={cn('absolute inset-y-3 left-0 w-1 rounded-r-sm', state.markerClass)} aria-hidden="true" />

      <div className="flex h-full min-w-0 flex-col px-4 pb-3 pt-3.5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-mono-family text-[10px] font-semibold text-muted-foreground">
              {kindLabel}
            </p>
            <p className="mt-1 truncate text-sm font-semibold" title={data.id}>{data.id}</p>
          </div>
          <span className={cn('flex shrink-0 items-center gap-1 border px-2 py-1 text-[10px] font-medium', state.badgeClass)}>
            <StatusIcon
              className={cn('size-3', data.status === 'running' && 'animate-spin')}
              aria-hidden="true"
            />
            {state.label}
          </span>
        </div>

        <p className="mt-2 line-clamp-2 min-h-8 text-[11px] leading-4 text-muted-foreground" title={data.summary}>
          {data.summary || '等待步骤输入'}
        </p>

        <div className="mt-auto">
          <div className="mb-1.5 flex items-center justify-between gap-3 font-mono-family text-[10px] text-muted-foreground">
            <span>{attempt ? `尝试 ${attempt}` : '未尝试'}</span>
            <span>
              {cost == null ? '' : `$${cost.toFixed(4)} · `}
              {progress == null ? (data.status === 'running' ? '进行中' : '未计量') : `${Math.round(progress)}%`}
            </span>
          </div>
          <div
            className="h-1 overflow-hidden bg-surface-container-high"
            role="progressbar"
            aria-label={`${data.id} 步骤进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-valuetext={progress == null ? state.label : `${Math.round(progress)}%`}
          >
            <div
              className={cn(
                'h-full transition-[width]',
                state.progressClass,
                progress == null && data.status === 'running' && 'animate-pulse',
              )}
              style={{ width: progressWidth }}
            />
          </div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
        className="!h-6 !w-6 !border-[7px] !border-surface-container-lowest !bg-outline transition-colors hover:!bg-primary"
        aria-label={`${data.id} 输出连接点`}
        title="输出连接点"
      />
    </div>
  );
}

export const StepNode = memo(StepNodeComponent);
