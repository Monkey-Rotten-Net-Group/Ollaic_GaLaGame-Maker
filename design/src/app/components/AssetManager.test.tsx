import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetManager } from './AssetManager';
import { listAssets, listAllAssets, type AssetInfo } from '../lib/assets-ipc';
import { loadAssetMetadata } from '../lib/asset-metadata';
import { getAiTtsConfig } from '../lib/ai-ipc';
import { getScenePath, loadScene, openProject } from '../lib/webgal-ipc';
import { listCharacters } from '../lib/character-ipc';

vi.mock('../lib/assets-ipc', () => ({
  listAssets: vi.fn(),
  listAllAssets: vi.fn(),
  importAsset: vi.fn(),
  saveGeneratedAsset: vi.fn(),
  deleteAsset: vi.fn(),
  renameAsset: vi.fn(),
  findAssetUsages: vi.fn(async () => []),
}));

vi.mock('../lib/asset-metadata', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/asset-metadata')>()),
  loadAssetMetadata: vi.fn(),
}));

vi.mock('../lib/ai-ipc', () => ({
  getAiImageConfig: vi.fn(),
  getAiTtsConfig: vi.fn(),
  aiGenerateImage: vi.fn(),
  aiGenerateTts: vi.fn(),
  listenAiMediaGenerationProgress: vi.fn(async () => vi.fn()),
}));

vi.mock('../lib/webgal-ipc', () => ({
  getScenePath: vi.fn(),
  loadScene: vi.fn(async () => []),
  openProject: vi.fn(),
  saveScene: vi.fn(),
}));

vi.mock('../lib/character-ipc', () => ({
  listCharacters: vi.fn(async () => []),
}));

const projectPath = '/tmp/project';

const bgmAsset: AssetInfo = {
  name: 'battle_theme.mp3',
  path: `${projectPath}/game/bgm/battle_theme.mp3`,
  category: 'bgm',
  size: 1024,
  extension: 'mp3',
};

const backgroundAsset: AssetInfo = {
  name: 'classroom.png',
  path: `${projectPath}/game/background/classroom.png`,
  category: 'background',
  size: 2048,
  extension: 'png',
};

function renderManager() {
  return render(
    <MemoryRouter initialEntries={['/projects/demo/assets']}>
      <Routes>
        <Route path="/projects/:projectId/assets" element={<AssetManager />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AssetManager inspector AI generation entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('project-path-demo', projectPath);
    vi.mocked(loadAssetMetadata).mockResolvedValue({
      aliases: {},
      descriptions: {},
      references: {},
      sceneCards: {},
      cgCards: {},
      voiceCards: {},
      deletedSceneCards: [],
      deletedCgCards: [],
      deletedVoiceCards: [],
    } as any);
    vi.mocked(getScenePath).mockResolvedValue(`${projectPath}/game/scene/scene1.txt`);
    vi.mocked(openProject).mockResolvedValue({ scenes: [] } as any);
    vi.mocked(getAiTtsConfig).mockResolvedValue({ provider: 'openai', model: 'tts-1' } as any);
    vi.mocked(listAllAssets).mockResolvedValue([]);
    vi.mocked(listAssets).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('hides the AI generate button for imported BGM files', async () => {
    const user = userEvent.setup();
    vi.mocked(listAssets).mockImplementation(async (_project, category) => (category === 'bgm' ? [bgmAsset] : []));
    vi.mocked(listAllAssets).mockResolvedValue([bgmAsset]);

    renderManager();

    await user.click(await screen.findByRole('button', { name: /^音频/ }));
    const card = await screen.findByText('battle_theme.mp3');
    await user.click(card);

    expect(screen.getByRole('button', { name: '重命名素材' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI 生成' })).not.toBeInTheDocument();
  });

  it('keeps the AI generate button for image assets', async () => {
    const user = userEvent.setup();
    vi.mocked(listAssets).mockImplementation(async (_project, category) => (category === 'background' ? [backgroundAsset] : []));
    vi.mocked(listAllAssets).mockResolvedValue([backgroundAsset]);

    renderManager();

    await user.click((await screen.findAllByText('classroom.png'))[0]);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'AI 生成' })).toBeInTheDocument();
    });
  });
});
