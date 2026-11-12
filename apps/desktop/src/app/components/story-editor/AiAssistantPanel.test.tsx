import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiEditScope } from '../../lib/story-agent';
import type { WebGalNode } from '../../lib/webgal-types';
import { AiAssistantPanel, AiInputBox } from './AiAssistantPanel';

vi.mock('../../hooks/useChatModelSelection', () => ({
  useChatModelSelection: () => ({
    config: { provider: 'openai', model: 'gpt-4o', customModels: ['gpt-4o'] },
    catalog: { chat: [{ value: 'openai', label: 'OpenAI' }] },
    loading: false,
    switching: false,
    error: null,
    refresh: vi.fn(async () => {}),
    switchModel: vi.fn(async () => {}),
  }),
}));

afterEach(cleanup);

function makeAgentMock(overrides: Record<string, unknown> = {}) {
  const noop = vi.fn();
  const noopAsync = vi.fn(async () => {});
  return {
    sessions: [{ id: 's1', title: '新对话', createdAt: '1', updatedAt: '1' }],
    activeId: 's1',
    messages: [{ id: '1', role: 'assistant' as const, content: '你好' }],
    busy: false,
    committing: false,
    status: 'idle' as const,
    stepLabel: '',
    pendingChangeSet: null,
    error: null,
    cooldown: 0,
    missingIssues: [],
    streamingIdRef: { current: null },
    input: '',
    editScope: 'scene' as AiEditScope,
    setEditScope: noop,
    memory: null,
    uploads: [],
    attachedIds: [],
    uploadBusy: false,
    uploadError: null,
    startNewSession: noop,
    selectSession: noop,
    removeSession: noop,
    renameSession: noop,
    acceptChange: noopAsync,
    revertChange: noop,
    forceApplyChange: noopAsync,
    regenerateAfterConflict: noop,
    retry: noop,
    stop: noop,
    saveMemory: noopAsync,
    addUploads: noopAsync,
    attachUpload: noop,
    detachUpload: noop,
    removeUpload: noopAsync,
    previewUpload: vi.fn(async () => null),
    clearUploadError: noop,
    useFallbackAssets: noop,
    openAssets: noop,
    retryWithExistingAssets: noop,
    ...overrides,
  } as never;
}

describe('Agent input commands', () => {
  it.each(['/help', '/plan'])('submits the complete %s command on Enter', async (command) => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <AiInputBox
        value=""
        busy={false}
        locked={false}
        pending={false}
        isPlanMode={false}
        onTogglePlanMode={vi.fn()}
        onSubmit={onSubmit}
        onStop={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('AI 创作输入'), `${command}{Enter}`);
    expect(onSubmit).toHaveBeenCalledWith(command);
  });

  it('uses plan mode for one submission and then returns to editing', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    function Harness() {
      const [planMode, setPlanMode] = useState(true);
      return (
        <AiInputBox
          value=""
          busy={false}
          locked={false}
          pending={false}
          isPlanMode={planMode}
          onTogglePlanMode={() => setPlanMode((mode) => !mode)}
          onSubmit={onSubmit}
          onStop={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('AI 创作输入');
    await user.type(input, '暴雨夜{Enter}');
    await user.type(input, '把对白改短{Enter}');
    expect(onSubmit.mock.calls.map(([text]) => text)).toEqual(['/workflow 暴雨夜', '把对白改短']);
  });
});

describe('AiAssistantPanel scope selector and prompt submission', () => {
  it('defaults to scene scope when no node is selected and sends raw prompt without wrapping', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <AiAssistantPanel
        aiAgent={makeAgentMock()}
        projectPath="/tmp/proj"
        sceneHeaders={{}}
        currentSceneName="start.txt"
        selectedNode={null}
        onOpenSettings={vi.fn()}
        onOpenMemory={vi.fn()}
        onSend={onSend}
      />,
    );

    const scopeButton = screen.getByLabelText('切换上下文关联范围');
    expect(scopeButton).toHaveTextContent('场景 (start)');
    expect(scopeButton).not.toHaveTextContent('全文');
    expect(screen.getByText('场景级')).toBeInTheDocument();

    await user.type(screen.getByLabelText('AI 创作输入'), '1{Enter}');
    expect(onSend).toHaveBeenCalledWith('1');
  });

  it('switches between scene and full-story scope in the dropdown and updates labels', async () => {
    const user = userEvent.setup();
    function Harness({ selectedNode }: { selectedNode: WebGalNode | null }) {
      const [scope, setScope] = useState<AiEditScope>(selectedNode ? 'node' : 'scene');
      return (
        <AiAssistantPanel
          aiAgent={makeAgentMock({ editScope: scope, setEditScope: setScope })}
          projectPath="/tmp/proj"
          sceneHeaders={{}}
          currentSceneName="start.txt"
          selectedNode={selectedNode}
          selectedNodeIndex={0}
          onOpenSettings={vi.fn()}
          onOpenMemory={vi.fn()}
          onSend={vi.fn()}
        />
      );
    }

    render(<Harness selectedNode={null} />);
    await user.click(screen.getByLabelText('切换上下文关联范围'));
    await user.click(screen.getByRole('menuitem', { name: /全剧范围/ }));

    expect(screen.getByLabelText('切换上下文关联范围')).toHaveTextContent('全剧范围');
    expect(screen.getByText('全剧级')).toBeInTheDocument();
  });

  it('shows node focus when selected and falls back to scene scope when selection is cleared', () => {
    const node: WebGalNode = {
      id: 'n1',
      type: 'dialogue',
      character: '林夏',
      content: '你好',
      flags: [],
      position: { x: 0, y: 0 },
      connections: [],
    };
    const agent = makeAgentMock({ editScope: 'node' });
    const { rerender } = render(
      <AiAssistantPanel
        aiAgent={agent}
        projectPath="/tmp/proj"
        sceneHeaders={{}}
        currentSceneName="start.txt"
        selectedNode={node}
        selectedNodeIndex={0}
        onOpenSettings={vi.fn()}
        onOpenMemory={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('切换上下文关联范围')).toHaveTextContent('Line 01 [林夏 对白]');
    expect(screen.getByText('行级聚焦')).toBeInTheDocument();

    rerender(
      <AiAssistantPanel
        aiAgent={agent}
        projectPath="/tmp/proj"
        sceneHeaders={{}}
        currentSceneName="start.txt"
        selectedNode={null}
        onOpenSettings={vi.fn()}
        onOpenMemory={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('切换上下文关联范围')).toHaveTextContent('场景 (start)');
    expect(screen.getByText('场景级')).toBeInTheDocument();
  });
});
