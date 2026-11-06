import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AiInputBox } from './AiAssistantPanel';

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
