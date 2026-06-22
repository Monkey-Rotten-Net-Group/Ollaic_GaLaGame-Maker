import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowRight,
  BookOpen,
  Clock,
  Edit,
  FileDown,
  Folder,
  FolderOpen,
  Grid3x3,
  Home,
  Layout,
  List as ListIcon,
  Loader2,
  MapPin,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { initProject, openProject, type ProjectInfo } from '../lib/webgal-ipc';
import { saveProjectMemory } from '../lib/project-memory';
import { StoryOsPanel } from './StoryOsChrome';

export interface Project {
  id: string;
  name: string;
  description: string;
  lastModified: string;
  path: string;
  thumbnail?: string;
  isFavorite: boolean;
  sceneCount: number;
  deleted?: boolean;
}

const STORAGE_KEY = 'webgal-projects';

function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistProjects(projects: Project[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function ProjectHome() {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [sidebarFilter, setSidebarFilter] = useState<'all' | 'favorites' | 'recent' | 'trash'>('all');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  useEffect(() => {
    persistProjects(projects);
  }, [projects]);

  useEffect(() => {
    for (const p of projects) localStorage.setItem(`project-path-${p.id}`, p.path);
  }, [projects]);

  const activeProjects = projects.filter((project) => !project.deleted);

  // Time-aware greeting + engineering-style date tag for the header.
  const greeting = useMemo(() => {
    const now = new Date();
    const hour = now.getHours();
    const title = hour < 5 ? '夜深了，创作者'
      : hour < 11 ? '早安，创作者'
      : hour < 14 ? '午安，创作者'
      : hour < 18 ? '下午好，创作者'
      : '晚上好，创作者';
    const pad = (n: number) => String(n).padStart(2, '0');
    const tag = `STORY OS · ${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} · 在线`;
    return { title, tag };
  }, []);

  const filterLabel = useMemo(() => {
    if (searchQuery.trim()) return '搜索结果';
    switch (sidebarFilter) {
      case 'favorites': return '我的收藏';
      case 'recent': return '最近编辑';
      case 'trash': return '回收站';
      default: return '全部项目';
    }
  }, [sidebarFilter, searchQuery]);

  const filteredProjects = useMemo(() => {
    let list = projects;
    switch (sidebarFilter) {
      case 'favorites':
        list = list.filter((p) => p.isFavorite && !p.deleted);
        break;
      case 'trash':
        list = list.filter((p) => p.deleted);
        break;
      case 'recent':
        list = list.filter((p) => !p.deleted).slice(0, 5);
        break;
      default:
        list = list.filter((p) => !p.deleted);
    }

    const query = searchQuery.trim().toLowerCase();
    if (!query) return list;
    return list.filter((p) =>
      p.name.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query) ||
      p.path.toLowerCase().includes(query),
    );
  }, [projects, searchQuery, sidebarFilter]);

  const openCreateDialog = () => {
    setIsModalOpen(true);
    setProjectName('');
    setProjectDesc('');
    setSelectedDir(null);
    setCreateError('');
  };

  const openEditDialog = (project: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProject(project);
    setEditName(project.name);
    setEditDesc(project.description);
  };

  const handleSaveEdit = () => {
    if (!editingProject) return;
    setProjects((prev) => prev.map((p) =>
      p.id === editingProject.id
        ? { ...p, name: editName.trim() || p.name, description: editDesc.trim() }
        : p,
    ));
    setEditingProject(null);
  };

  const handlePickDir = useCallback(async () => {
    const dir = await openDialog({
      title: '选择项目存放位置',
      directory: true,
    });
    if (dir) setSelectedDir(dir);
  }, []);

  const handleCreateProject = useCallback(async () => {
    const name = projectName.trim();
    if (!name || !selectedDir) return;

    setIsCreating(true);
    setCreateError('');
    try {
      const info: ProjectInfo = await initProject(selectedDir, name);
      const desc = projectDesc.trim();
      if (desc) {
        await saveProjectMemory(info.path, {
          worldSetting: desc,
          writingStyle: '',
          userPreferences: '',
          updatedAt: new Date().toISOString(),
        });
      }
      const newProject: Project = {
        id: Date.now().toString(),
        name: info.config.Game_name || name,
        description: desc || `WebGAL 项目 - ${name}`,
        lastModified: new Date().toLocaleString(),
        path: info.path,
        isFavorite: false,
        sceneCount: info.scenes.length,
      };
      setProjects((prev) => [newProject, ...prev]);
      setIsModalOpen(false);
      navigate(`/editor/${newProject.id}`);
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setIsCreating(false);
    }
  }, [navigate, projectDesc, projectName, selectedDir]);

  const handleOpenProject = useCallback(async () => {
    const dir = await openDialog({
      title: '打开 WebGAL 项目文件夹',
      directory: true,
    });
    if (!dir) return;

    try {
      const info: ProjectInfo = await openProject(dir);
      const existing = projects.find((p) => p.path === dir);
      if (existing) {
        localStorage.setItem(`project-path-${existing.id}`, existing.path);
        navigate(`/editor/${existing.id}`);
        return;
      }
      const newProject: Project = {
        id: Date.now().toString(),
        name: info.config.Game_name || dir.split('/').pop() || '未命名项目',
        description: `${info.scenes.length} 个场景`,
        lastModified: new Date().toLocaleString(),
        path: dir,
        isFavorite: false,
        sceneCount: info.scenes.length,
      };
      setProjects((prev) => [newProject, ...prev]);
      navigate(`/editor/${newProject.id}`);
    } catch (e) {
      alert(`无法打开项目: ${e}`);
    }
  }, [navigate, projects]);

  const toggleFavorite = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setProjects((prev) => prev.map((p) => p.id === id ? { ...p, isFavorite: !p.isFavorite } : p));
  };

  const deleteProject = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('移入回收站？（不会删除磁盘上的文件）')) {
      setProjects((prev) => prev.map((p) => p.id === id ? { ...p, deleted: true } : p));
    }
  };

  const restoreProject = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setProjects((prev) => prev.map((p) => p.id === id ? { ...p, deleted: false } : p));
  };

  const permanentlyDeleteProject = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('确定永久移除此项目？不会删除磁盘上的文件。')) {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      localStorage.removeItem(`project-path-${id}`);
    }
  };

  const filterButton = (
    id: typeof sidebarFilter,
    label: string,
    icon: React.ReactNode,
    count?: number,
  ) => (
    <button
      type="button"
      onClick={() => setSidebarFilter(id)}
      className={`flex items-center gap-3 rounded px-3 py-2 text-left text-sm transition-colors md:w-full ${
        sidebarFilter === id
          ? 'border border-secondary/30 bg-secondary/20 text-secondary'
          : 'text-muted-foreground hover:bg-surface-container-high hover:text-foreground'
      }`}
    >
      {icon}
      <span className="font-medium">{label}</span>
      {count !== undefined && <span className="text-xs opacity-60 md:ml-auto">{count}</span>}
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-surface-container-lowest text-foreground">
      {/* Home header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface-bright px-4">
        <div className="flex items-center gap-3">
          <div className="story-os-chamfer-tr flex h-7 w-7 items-center justify-center bg-primary/10 text-primary">
            <Home className="h-4 w-4" />
          </div>
          <span className="font-display-family text-base font-semibold tracking-tight text-primary">
            Story OS
          </span>
          <span className="hidden font-mono-family text-[10px] font-semibold uppercase tracking-widest text-muted-foreground sm:inline">工作台</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative hidden sm:block">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-64 rounded border border-border bg-input-background py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              placeholder="搜索项目..."
              aria-label="搜索项目"
            />
          </div>
        </div>
      </header>

      <main className="story-os-blueprint min-h-0 flex-1 overflow-hidden bg-surface-container-low p-4">
        <div className="mx-auto flex h-full max-w-7xl flex-col gap-5 pt-2">
          {/* Greeting */}
          <div className="relative shrink-0">
            <div className="mb-2 inline-flex items-center gap-2 rounded border border-border/60 bg-surface-container-lowest/80 px-2.5 py-1 font-mono-family text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant backdrop-blur">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-tertiary animate-pulse" />
              {greeting.tag}
            </div>
            <h1 className="font-display-family text-3xl font-semibold tracking-tight text-foreground">{greeting.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Story OS 2.0 准备就绪，今天想创造怎样的世界？</p>
          </div>

          {/* Quick actions */}
          <div className="grid shrink-0 grid-cols-1 gap-4 md:grid-cols-2">
            <button
              type="button"
              onClick={openCreateDialog}
              className="story-os-hard-shadow story-os-chamfer-tr group relative flex items-center gap-4 overflow-hidden border border-l-4 border-border border-l-primary bg-surface-container-lowest p-5 text-left transition-all hover:-translate-y-0.5 hover:bg-surface-container"
            >
              <div className="story-os-dot-grid pointer-events-none absolute inset-0 opacity-40" />
              <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:scale-110">
                <Plus className="h-6 w-6" />
              </div>
              <div className="relative min-w-0">
                <div className="text-lg font-semibold">新建项目</div>
                <div className="text-sm text-muted-foreground">从零开始构建剧本</div>
              </div>
              <ArrowRight className="relative ml-auto h-5 w-5 shrink-0 text-muted-foreground opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100" />
            </button>
            <button
              type="button"
              onClick={handleOpenProject}
              className="story-os-hard-shadow story-os-chamfer-tr group relative flex items-center gap-4 overflow-hidden border border-l-4 border-border border-l-accent bg-surface-container-lowest p-5 text-left transition-all hover:-translate-y-0.5 hover:bg-surface-container"
            >
              <div className="story-os-dot-grid pointer-events-none absolute inset-0 opacity-40" />
              <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-secondary/10 text-secondary transition-transform group-hover:scale-110">
                <FileDown className="h-6 w-6" />
              </div>
              <div className="relative min-w-0">
                <div className="text-lg font-semibold">打开已有项目</div>
                <div className="text-sm text-muted-foreground">导入已有 WebGAL 工程</div>
              </div>
              <ArrowRight className="relative ml-auto h-5 w-5 shrink-0 text-muted-foreground opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100" />
            </button>
          </div>

          {/* Project library */}
          <StoryOsPanel
            title="项目库"
            icon={Folder}
            className="flex min-h-0 flex-1 flex-col"
            action={(
              <div className="flex items-center gap-1 rounded border border-border bg-surface-container px-1 py-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`rounded p-1 ${viewMode === 'grid' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-surface-container-high'}`}
                  aria-label="网格视图"
                >
                  <Grid3x3 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className={`rounded p-1 ${viewMode === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-surface-container-high'}`}
                  aria-label="列表视图"
                >
                  <ListIcon className="h-4 w-4" />
                </button>
              </div>
            )}
          >
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)]">
              {/* Left filter sidebar */}
              <aside className="flex flex-row flex-wrap gap-1.5 border-b border-border/50 bg-surface-container-lowest p-3 md:flex-col md:gap-1 md:border-b-0 md:border-r md:overflow-y-auto">
                {filterButton('all', '全部项目', <Folder className="h-4 w-4" />, activeProjects.length)}
                {filterButton('favorites', '我的收藏', <Star className="h-4 w-4" />, activeProjects.filter((p) => p.isFavorite).length)}
                {filterButton('recent', '最近编辑', <Clock className="h-4 w-4" />)}
                {filterButton('trash', '回收站', <Trash2 className="h-4 w-4" />, projects.filter((p) => p.deleted).length)}

                <div className="mt-auto hidden rounded border border-primary/10 bg-gradient-to-br from-primary/5 to-transparent p-3 md:block">
                  <h3 className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                    <BookOpen className="h-3.5 w-3.5" />
                    使用技巧
                  </h3>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                    点击星标可收藏常用项目。项目较多时，可用右上角搜索框或切换列表视图快速定位。
                  </p>
                </div>
              </aside>

              {/* Right project area */}
              <div className="flex min-h-0 flex-col p-4">
                {/* Result count bar */}
                <div className="mb-3 flex shrink-0 items-center justify-between">
                  <span className="font-mono-family text-[11px] uppercase tracking-widest text-muted-foreground">
                    {filterLabel} · {filteredProjects.length} 个
                  </span>
                  {searchQuery.trim() && (
                    <button type="button" onClick={() => setSearchQuery('')} className="text-xs text-primary hover:underline">
                      清除搜索
                    </button>
                  )}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                {filteredProjects.length === 0 ? (
                  <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded border-2 border-dashed border-border/50 bg-surface-container-low text-center text-muted-foreground">
                    {(() => {
                      if (searchQuery.trim()) {
                        return (
                          <>
                            <div className="mb-3 rounded-full bg-surface-container p-3">
                              <Search className="h-8 w-8 opacity-30" />
                            </div>
                            <p className="text-sm font-medium">没有找到相关项目</p>
                            <p className="mt-1 text-xs text-muted-foreground/60">换个关键词试试</p>
                            <button type="button" onClick={() => setSearchQuery('')} className="mt-3 text-xs text-primary hover:underline">
                              清除搜索
                            </button>
                          </>
                        );
                      }
                      if (sidebarFilter === 'trash') {
                        return (
                          <>
                            <div className="mb-3 rounded-full bg-surface-container p-3">
                              <Trash2 className="h-8 w-8 opacity-30" />
                            </div>
                            <p className="text-sm font-medium">回收站是空的</p>
                            <p className="mt-1 text-xs text-muted-foreground/60">移入回收站的项目将在这里显示</p>
                          </>
                        );
                      }
                      if (sidebarFilter === 'favorites') {
                        return (
                          <>
                            <div className="mb-3 rounded-full bg-surface-container p-3">
                              <Star className="h-8 w-8 opacity-20" />
                            </div>
                            <p className="text-sm font-medium">还没有收藏的项目</p>
                            <p className="mt-1 text-xs text-muted-foreground/60">点击项目卡片上的星标即可收藏</p>
                          </>
                        );
                      }
                      if (sidebarFilter === 'recent') {
                        return (
                          <>
                            <div className="mb-3 rounded-full bg-surface-container p-3">
                              <Clock className="h-8 w-8 opacity-20" />
                            </div>
                            <p className="text-sm font-medium">暂无最近编辑的项目</p>
                            <p className="mt-1 text-xs text-muted-foreground/60">打开项目后将在这里显示</p>
                          </>
                        );
                      }
                      return (
                        <>
                          <div className="mb-3 rounded-full bg-surface-container p-3">
                            <Folder className="h-8 w-8 opacity-30" />
                          </div>
                          <p className="text-sm font-medium">还没有项目</p>
                          <p className="mt-1 text-xs text-muted-foreground/60">创建新项目或打开已有的 WebGAL 项目开始</p>
                          <div className="mt-4 flex gap-2">
                            <button type="button" onClick={handleOpenProject} className="rounded border border-border bg-surface-container px-3 py-1.5 text-xs hover:bg-surface-container-high">
                              <FolderOpen className="mr-1 inline h-3 w-3" />
                              打开项目
                            </button>
                            <button type="button" onClick={openCreateDialog} className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground">
                              <Plus className="mr-1 inline h-3 w-3" />
                              创建新项目
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                ) : viewMode === 'grid' ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                    {filteredProjects.map((project) => (
                      <ProjectRecord
                        key={project.id}
                        project={project}
                        deletedView={sidebarFilter === 'trash'}
                        onOpen={() => !project.deleted && navigate(`/editor/${project.id}`)}
                        onFavorite={toggleFavorite}
                        onEdit={openEditDialog}
                        onDelete={deleteProject}
                        onRestore={restoreProject}
                        onPermanentDelete={permanentlyDeleteProject}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredProjects.map((project) => (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        deletedView={sidebarFilter === 'trash'}
                        onOpen={() => !project.deleted && navigate(`/editor/${project.id}`)}
                        onFavorite={toggleFavorite}
                        onEdit={openEditDialog}
                        onDelete={deleteProject}
                        onRestore={restoreProject}
                        onPermanentDelete={permanentlyDeleteProject}
                      />
                    ))}
                  </div>
                )}
                </div>
              </div>
            </div>
          </StoryOsPanel>
        </div>
      </main>

      {isModalOpen && (
        <ProjectModal
          projectName={projectName}
          projectDesc={projectDesc}
          selectedDir={selectedDir}
          isCreating={isCreating}
          createError={createError}
          onClose={() => !isCreating && setIsModalOpen(false)}
          onPickDir={handlePickDir}
          onCreate={handleCreateProject}
          onNameChange={setProjectName}
          onDescChange={setProjectDesc}
        />
      )}

      {editingProject && (
        <EditProjectDialog
          project={editingProject}
          editName={editName}
          editDesc={editDesc}
          onClose={() => setEditingProject(null)}
          onNameChange={setEditName}
          onDescChange={setEditDesc}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
}

interface ProjectRecordProps {
  project: Project;
  deletedView: boolean;
  onOpen: () => void;
  onFavorite: (id: string, e: React.MouseEvent) => void;
  onEdit: (project: Project, e: React.MouseEvent) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRestore: (id: string, e: React.MouseEvent) => void;
  onPermanentDelete: (id: string, e: React.MouseEvent) => void;
}

function ProjectRecord({
  project,
  deletedView,
  onOpen,
  onFavorite,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
}: ProjectRecordProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`story-os-interactive story-os-chamfer-tr group cursor-pointer overflow-hidden border border-border bg-surface-container-lowest text-left hover:border-primary/40 ${project.deleted ? 'opacity-70' : ''}`}
    >
      <div className="story-os-blueprint relative aspect-[16/9] overflow-hidden bg-gradient-to-br from-secondary/25 to-surface-container">
        <div className="flex h-full w-full items-center justify-center">
          <BookOpen className="h-16 w-16 text-muted-foreground opacity-15 transition-transform duration-300 group-hover:scale-110" />
        </div>
        {project.isFavorite && (
          <div className="absolute left-3 top-3">
            <Star className="h-4 w-4 fill-primary text-primary drop-shadow" />
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3">
          <div className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 font-mono-family text-[10px] text-white backdrop-blur">
            <Layout className="h-3 w-3" />
            {project.sceneCount} 场景
          </div>
        </div>
        <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {deletedView ? (
            <>
              <button type="button" onClick={(e) => onRestore(project.id, e)} className="rounded bg-background/80 p-1.5 text-tertiary" aria-label="还原项目">
                <Edit className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={(e) => onPermanentDelete(project.id, e)} className="rounded bg-background/80 p-1.5 text-destructive" aria-label="永久删除项目">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={(e) => onFavorite(project.id, e)} className={`rounded p-1.5 ${project.isFavorite ? 'bg-primary text-primary-foreground' : 'bg-background/80 text-muted-foreground'}`} aria-label="收藏项目">
                <Star className={`h-3.5 w-3.5 ${project.isFavorite ? 'fill-current' : ''}`} />
              </button>
              <button type="button" onClick={(e) => onEdit(project, e)} className="rounded bg-background/80 p-1.5 text-muted-foreground" aria-label="编辑项目">
                <Edit className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={(e) => onDelete(project.id, e)} className="rounded bg-background/80 p-1.5 text-destructive" aria-label="删除项目">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="p-3">
        <div className="truncate text-base font-semibold group-hover:text-primary">{project.name}</div>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{project.description}</p>
        <div className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-2 font-mono-family text-[10px] text-muted-foreground">
          <MapPin className="h-3 w-3 shrink-0 opacity-60" />
          <span className="truncate">{project.path}</span>
        </div>
      </div>
    </div>
  );
}

function ProjectRow(props: ProjectRecordProps) {
  const { project, deletedView, onOpen, onFavorite, onEdit, onDelete, onRestore, onPermanentDelete } = props;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`story-os-interactive group flex w-full cursor-pointer items-center gap-4 rounded border border-border bg-surface-container-lowest p-3 text-left hover:border-primary/40 ${project.deleted ? 'opacity-70' : ''}`}
    >
      <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-secondary/30 to-surface-container">
        <BookOpen className="h-5 w-5 text-muted-foreground opacity-20" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate font-semibold group-hover:text-primary">{project.name}</div>
          {project.isFavorite && <Star className="h-4 w-4 fill-current text-primary" />}
        </div>
        <div className="truncate text-sm text-muted-foreground">{project.description}</div>
        <div className="truncate text-[10px] text-muted-foreground">{project.path}</div>
      </div>
      <div className="hidden text-right text-xs text-muted-foreground md:block">
        <div>{project.sceneCount} 场景</div>
        <div>{project.lastModified}</div>
      </div>
      <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {deletedView ? (
          <>
            <button type="button" onClick={(e) => onRestore(project.id, e)} className="rounded p-1.5 text-tertiary hover:bg-tertiary/10" aria-label="还原项目"><Edit className="h-4 w-4" /></button>
            <button type="button" onClick={(e) => onPermanentDelete(project.id, e)} className="rounded p-1.5 text-destructive hover:bg-destructive/10" aria-label="永久删除项目"><Trash2 className="h-4 w-4" /></button>
          </>
        ) : (
          <>
            <button type="button" onClick={(e) => onFavorite(project.id, e)} className="rounded p-1.5 text-muted-foreground hover:bg-surface-container-high hover:text-primary" aria-label="收藏项目"><Star className={`h-4 w-4 ${project.isFavorite ? 'fill-current text-primary' : ''}`} /></button>
            <button type="button" onClick={(e) => onEdit(project, e)} className="rounded p-1.5 text-muted-foreground hover:bg-surface-container-high" aria-label="编辑项目"><Edit className="h-4 w-4" /></button>
            <button type="button" onClick={(e) => onDelete(project.id, e)} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="删除项目"><Trash2 className="h-4 w-4" /></button>
          </>
        )}
      </div>
    </div>
  );
}

interface ProjectModalProps {
  projectName: string;
  projectDesc: string;
  selectedDir: string | null;
  isCreating: boolean;
  createError: string;
  onClose: () => void;
  onPickDir: () => void;
  onCreate: () => void;
  onNameChange: (value: string) => void;
  onDescChange: (value: string) => void;
}

function ProjectModal(props: ProjectModalProps) {
  const {
    projectName,
    projectDesc,
    selectedDir,
    isCreating,
    createError,
    onClose,
    onPickDir,
    onCreate,
    onNameChange,
    onDescChange,
  } = props;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-md">
      <div className="story-os-panel w-full max-w-lg">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="story-os-chamfer-tr rounded bg-primary/15 p-2 text-primary">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">创建新项目</h2>
              <p className="text-sm text-muted-foreground">创建标准 WebGAL 项目目录结构</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-muted-foreground hover:bg-surface-container-high" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-widest text-muted-foreground">项目名称</label>
            <input
              type="text"
              autoFocus
              value={projectName}
              onChange={(e) => onNameChange(e.target.value)}
              className="w-full rounded border border-border bg-input-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
              placeholder="例: 我的故事"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-widest text-muted-foreground">故事简介</label>
            <textarea
              value={projectDesc}
              onChange={(e) => onDescChange(e.target.value)}
              className="h-20 w-full resize-none rounded border border-border bg-input-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
              placeholder="描述故事背景、世界观或主要人物关系..."
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-widest text-muted-foreground">存放位置</label>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1 truncate rounded border border-border bg-surface-container-low px-3 py-2 text-sm text-muted-foreground">
                {selectedDir || '请选择文件夹...'}
              </div>
              <button type="button" onClick={onPickDir} className="rounded border border-border bg-surface-container px-3 py-2 hover:bg-surface-container-high" aria-label="浏览文件夹">
                <FolderOpen className="h-4 w-4" />
              </button>
            </div>
            {selectedDir && (
              <p className="mt-2 text-xs text-muted-foreground">
                将创建: {selectedDir}/{projectName || '...'}/game/
              </p>
            )}
          </div>
          {createError && <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{createError}</div>}
          <button
            type="button"
            onClick={onCreate}
            disabled={!projectName.trim() || !selectedDir || isCreating}
            className="story-os-chamfer-tr flex w-full items-center justify-center gap-2 rounded bg-primary py-3 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {isCreating ? '创建中...' : '创建项目'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface EditProjectDialogProps {
  project: Project;
  editName: string;
  editDesc: string;
  onClose: () => void;
  onNameChange: (value: string) => void;
  onDescChange: (value: string) => void;
  onSave: () => void;
}

function EditProjectDialog({
  project,
  editName,
  editDesc,
  onClose,
  onNameChange,
  onDescChange,
  onSave,
}: EditProjectDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-md" onClick={onClose}>
      <div className="story-os-panel w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold">编辑项目信息</h2>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-muted-foreground hover:bg-surface-container-high" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-6">
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-widest text-muted-foreground">项目名称</label>
            <input
              type="text"
              autoFocus
              value={editName}
              onChange={(e) => onNameChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSave()}
              className="w-full rounded border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-widest text-muted-foreground">简介</label>
            <textarea
              value={editDesc}
              onChange={(e) => onDescChange(e.target.value)}
              rows={3}
              className="w-full resize-none rounded border border-border bg-input-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-widest text-muted-foreground">存放位置</label>
            <div className="flex items-center gap-2 rounded border border-border/60 bg-surface-container-low px-3 py-2">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs text-muted-foreground">{project.path}</span>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <button type="button" onClick={onClose} className="rounded bg-surface-container px-4 py-2 text-sm hover:bg-surface-container-high">取消</button>
          <button type="button" onClick={onSave} disabled={!editName.trim()} className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">保存</button>
        </div>
      </div>
    </div>
  );
}
