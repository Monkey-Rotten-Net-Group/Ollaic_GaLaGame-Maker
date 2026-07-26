import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { buildInlineUploadContext, buildUploadContext, formatUploadSize, type AiUpload } from './ai-uploads-ipc';
import { getTool } from './ai-tools';

const invokeMock = vi.mocked(invoke);

function upload(overrides: Partial<AiUpload> = {}): AiUpload {
  return {
    id: 'ref-1',
    name: '设定集.md',
    storedName: 'ref-1-.md',
    extension: 'md',
    size: 2048,
    charCount: 120,
    lineCount: 12,
    summary: '主角是一名侦探',
    importedAt: '1700000000000',
    ...overrides,
  };
}

describe('buildUploadContext', () => {
  it('is empty when nothing is attached, so the prompt prefix stays unchanged', () => {
    expect(buildUploadContext([])).toBe('');
  });

  it('omits stored files that were not attached to this message', () => {
    // Attaching is the access gate: an unrelated leftover upload must not be
    // mentioned at all, or the model will try to use it.
    expect(buildUploadContext([upload()], [])).toBe('');
    expect(buildUploadContext([upload({ id: 'ref-other' })], ['ref-1'])).toBe('');
  });

  it('lists names and summaries but never full file text', () => {
    const context = buildUploadContext([upload()], ['ref-1']);
    expect(context).toContain('设定集.md');
    expect(context).toContain('ref-1');
    expect(context).toContain('主角是一名侦探');
    expect(context).toContain('read_reference_file');
  });

  it('lists only the attached subset when the project holds more files', () => {
    const context = buildUploadContext(
      [upload({ id: 'ref-old', name: '安卓开发文档.md' }), upload({ id: 'ref-new', name: '新稿.md' })],
      ['ref-new'],
    );
    expect(context).toContain('新稿.md');
    expect(context).not.toContain('安卓开发文档.md');
  });

  it('tells the model to ignore an attachment that does not fit the request', () => {
    const context = buildUploadContext([upload()], ['ref-1']);
    expect(context).toContain('与用户的请求无关');
  });

  it('caps the listing and points at the tool for the rest', () => {
    const many = Array.from({ length: 25 }, (_, i) => upload({ id: `ref-${i}`, name: `f${i}.txt` }));
    const context = buildUploadContext(many, many.map((m) => m.id), 20);
    expect(context).toContain('另有 5 个附件未列出');
  });
});

describe('formatUploadSize', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatUploadSize(512)).toBe('512 B');
    expect(formatUploadSize(2048)).toBe('2.0 KB');
    expect(formatUploadSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('buildInlineUploadContext', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('inlines attached text for providers that cannot call tools', async () => {
    invokeMock.mockResolvedValue({
      id: 'ref-1', name: '设定集.md', text: '主角是一名侦探', fromLine: 1, toLine: 1, totalLines: 1, truncated: false,
    });
    const context = await buildInlineUploadContext('/tmp/project', [upload()], ['ref-1']);
    expect(context).toContain('设定集.md');
    expect(context).toContain('主角是一名侦探');
  });

  it('inlines nothing when no file is attached to this message', async () => {
    expect(await buildInlineUploadContext('/tmp/project', [upload()], [])).toBe('');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('keeps going when one attachment cannot be read', async () => {
    invokeMock.mockRejectedValue(new Error('gone'));
    const context = await buildInlineUploadContext('/tmp/project', [upload()], ['ref-1']);
    expect(context).toContain('读取失败');
  });
});

describe('reference file tools', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('list_reference_files summarizes attachments for the model', async () => {
    invokeMock.mockResolvedValue([upload()]);
    const result = await getTool('list_reference_files')!.run(
      {},
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', attachedUploadIds: ['ref-1'] },
    );

    expect(invokeMock).toHaveBeenCalledWith('list_ai_uploads', { projectPath: '/tmp/project' });
    expect(result).toEqual({
      total: 1,
      files: [{ id: 'ref-1', name: '设定集.md', lines: 12, chars: 120, summary: '主角是一名侦探' }],
    });
  });

  it('list_reference_files hides stored files that were not attached', async () => {
    invokeMock.mockResolvedValue([upload({ id: 'ref-other', name: '安卓开发文档.md' })]);
    const result = await getTool('list_reference_files')!.run(
      {},
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', attachedUploadIds: ['ref-1'] },
    ) as { total: number; files: unknown[] };

    expect(result.total).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('list_reference_files reports "nothing attached" instead of listing the store', async () => {
    const result = await getTool('list_reference_files')!.run(
      {},
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', attachedUploadIds: [] },
    ) as { total: number; message?: string };

    expect(result.total).toBe(0);
    expect(result.message).toContain('没有附加参考资料');
    // Never even queries the store — an unattached file is out of scope.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('read_reference_file pages through content with a default line cap', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_ai_uploads') return Promise.resolve([upload()]);
      return Promise.resolve({
        id: 'ref-1', name: '设定集.md', text: '第一行', fromLine: 1, toLine: 1, totalLines: 12, truncated: true,
      });
    });
    await getTool('read_reference_file')!.run(
      { id: 'ref-1' },
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', attachedUploadIds: ['ref-1'] },
    );

    expect(invokeMock).toHaveBeenCalledWith('read_ai_upload', {
      projectPath: '/tmp/project',
      id: 'ref-1',
      fromLine: 1,
      maxLines: 200,
    });
  });

  it('read_reference_file refuses a stored file the user did not attach', async () => {
    invokeMock.mockResolvedValue([upload({ id: 'ref-other', name: '安卓开发文档.md' })]);
    await expect(getTool('read_reference_file')!.run(
      { id: 'ref-other' },
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', attachedUploadIds: ['ref-1'] },
    )).rejects.toThrow('不在本条消息附加的参考资料中');
  });

  it('read_reference_file refuses by filename too, not just by id', async () => {
    invokeMock.mockResolvedValue([upload({ id: 'ref-other', name: '安卓开发文档.md' })]);
    await expect(getTool('read_reference_file')!.run(
      { id: '安卓开发文档.md' },
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', attachedUploadIds: ['ref-1'] },
    )).rejects.toThrow('不在本条消息附加的参考资料中');
  });

  it('read_reference_file refuses outright when nothing is attached', async () => {
    await expect(getTool('read_reference_file')!.run(
      { id: 'ref-1' },
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', attachedUploadIds: [] },
    )).rejects.toThrow('没有附加任何参考资料');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('read_reference_file asks for an id instead of guessing', async () => {
    await expect(getTool('read_reference_file')!.run(
      {},
      { projectPath: '/tmp/project', currentSceneName: 'start.txt', attachedUploadIds: ['ref-1'] },
    )).rejects.toThrow('read_reference_file 需要参考文件 id');
  });

  it('reference tools are read-only, so they can never stage project changes', () => {
    expect(getTool('list_reference_files')!.kind).toBe('read');
    expect(getTool('read_reference_file')!.kind).toBe('read');
  });

  it('reports a missing project instead of reading from nowhere', async () => {
    await expect(getTool('list_reference_files')!.run(
      {},
      { projectPath: null, currentSceneName: 'start.txt', attachedUploadIds: ['ref-1'] },
    )).rejects.toThrow('当前没有打开的项目');
  });
});
