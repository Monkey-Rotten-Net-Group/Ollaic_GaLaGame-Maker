import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from '@tauri-apps/api/core';
import {
  BookOpen,
  Clock,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Loader2,
  MapPin,
  Moon,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import {
  createManagedProject,
  getProjectStorage,
  initProject,
  openProject,
  type ProjectStorage,
} from '../lib/webgal-ipc';
import { loadAppSettings } from './AppSettingsDialog';
import { saveProjectMemory } from '../lib/project-memory';
import './ProjectHome.css';

export interface Project {
  id: string;
  name: string;
  description: string;
  lastModified: string;
  path?: string;
  isFavorite: boolean;
  sceneCount: number;
  deleted?: boolean;
  coverImage?: string;
}

type FilterKey = 'all' | 'favorites' | 'recent' | 'trash';
type ViewMode = 'grid' | 'list';
type SeedColor = 'violet' | 'crimson' | 'teal' | 'amber';

const PROJECTS_STORAGE_KEY = 'webgal-projects';
const SEED_STORAGE_KEY = 'ollaic:ph-seed-color-v3';

const HOME_THEME_STORAGE_KEY = 'ollaic-home-theme';

function loadProjectsFromStorage(): Project[] {
  try {
    const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore corrupted localStorage
  }
  return [];
}

function saveProjectsToStorage(list: Project[]): void {
  try {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore storage errors
  }
}

function formatNowTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function getSceneVariant(name: string, index = 0): number {
  if (!name) return index % 5;
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 5;
}

/**
 * Default Flat Geometric Visual Novel Scene Illustrations
 * Matches the clean flat SVG style in the user's reference screenshot:
 * - Variant 0: Sunset Window Frame & Golden Sun (黄昏窗格与落日)
 * - Variant 1: Summer Sky Red-White Lighthouse & Fluffy Cloud (红白灯塔与积雨云)
 * - Variant 2: Midnight Neon City Pillars (夜色霓虹街景)
 * - Variant 3: Starlit Rooftop & Crescent Moon (星夜天台)
 * - Variant 4: Warm Afternoon Bookshop Sunbeams (午后旧书屋)
 */
function DefaultSceneSvg({ variant, uid }: { variant: number; uid: string }) {
  switch (variant % 5) {
    case 0:
      // Sunset Window Frame & Golden Sun (matches left card in screenshot)
      return (
        <svg viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`s0-bg-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#9e4756" />
              <stop offset="65%" stopColor="#e58867" />
              <stop offset="100%" stopColor="#f5b971" />
            </linearGradient>
          </defs>
          <rect width="640" height="360" fill={`url(#s0-bg-${uid})`} />
          {/* Warm Golden Sun */}
          <circle cx="320" cy="185" r="82" fill="#f7d070" opacity="0.92" />
          {/* Classroom / Room Window Silhouette Frame */}
          <rect x="0" y="255" width="640" height="105" fill="#211624" />
          <rect x="0" y="242" width="640" height="6" fill="#f7d070" opacity="0.55" />
          <rect x="115" y="0" width="12" height="260" fill="#2b1d2e" />
          <rect x="313" y="0" width="14" height="260" fill="#2b1d2e" />
          <rect x="512" y="0" width="12" height="260" fill="#2b1d2e" />
          <rect x="0" y="138" width="640" height="11" fill="#2b1d2e" />
        </svg>
      );
    case 1:
      // Red-White Lighthouse & Fluffy Cloud on Azure Sea (matches center Hero & 2nd card in screenshot)
      return (
        <svg viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`s1-bg-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#266485" />
              <stop offset="72%" stopColor="#5aa2bd" />
              <stop offset="100%" stopColor="#8ec9db" />
            </linearGradient>
          </defs>
          <rect width="640" height="360" fill={`url(#s1-bg-${uid})`} />
          {/* Puffy White Cumulonimbus Cloud on Right */}
          <g fill="#f5f8fa">
            <circle cx="430" cy="195" r="46" />
            <circle cx="495" cy="170" r="64" />
            <circle cx="565" cy="192" r="52" />
            <rect x="425" y="192" width="145" height="50" rx="22" />
          </g>
          {/* Ocean Horizon Band */}
          <rect x="0" y="250" width="640" height="110" fill="#184763" />
          <rect x="315" y="264" width="245" height="4" rx="2" fill="#9ed8eb" opacity="0.65" />
          <rect x="365" y="280" width="175" height="3" rx="1.5" fill="#9ed8eb" opacity="0.45" />
          {/* Dark Headland Silhouette */}
          <path d="M0 245 Q 160 228 295 256 L 295 360 L 0 360 Z" fill="#152331" />
          {/* Iconic Red & White Lighthouse */}
          <polygon points="106,242 114,116 142,116 150,242" fill="#ffffff" />
          <polygon points="111,164 113,136 143,136 145,164" fill="#d9383a" />
          <polygon points="108,116 128,92 148,116" fill="#d9383a" />
        </svg>
      );
    case 2:
      // Midnight Neon City Pillars (matches 3rd card in screenshot)
      return (
        <svg viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <rect width="640" height="360" fill="#110e1c" />
          {/* Dark City Building Silhouettes */}
          <rect x="42" y="45" width="95" height="235" fill="#1b162b" />
          <rect x="165" y="85" width="120" height="195" fill="#171326" />
          <rect x="325" y="38" width="110" height="242" fill="#1d1830" />
          <rect x="468" y="72" width="115" height="208" fill="#171326" />
          {/* Glowing Vertical Neon Strips */}
          <rect x="74" y="65" width="14" height="110" rx="3" fill="#2dd4bf" />
          <rect x="392" y="55" width="14" height="95" rx="3" fill="#a855f7" />
          <rect x="515" y="105" width="10" height="75" rx="3" fill="#f43f5e" opacity="0.85" />
          {/* Wet Street Horizon */}
          <rect x="0" y="265" width="640" height="95" fill="#0b0914" />
          <rect x="65" y="292" width="120" height="4" rx="2" fill="#2dd4bf" opacity="0.5" />
          <rect x="360" y="305" width="145" height="4" rx="2" fill="#a855f7" opacity="0.5" />
        </svg>
      );
    case 3:
      // Starlit Rooftop & Crescent Moon
      return (
        <svg viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`s3-bg-${uid}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#161936" />
              <stop offset="60%" stopColor="#2e3366" />
              <stop offset="100%" stopColor="#54498c" />
            </linearGradient>
          </defs>
          <rect width="640" height="360" fill={`url(#s3-bg-${uid})`} />
          <circle cx="485" cy="110" r="36" fill="#fef08a" />
          <circle cx="500" cy="98" r="32" fill="#282c59" />
          <line
            x1="210"
            y1="65"
            x2="335"
            y2="125"
            stroke="#ffffff"
            strokeWidth="2.5"
            opacity="0.8"
          />
          <circle cx="140" cy="115" r="2.5" fill="#ffffff" opacity="0.7" />
          <circle cx="380" cy="80" r="2" fill="#ffffff" opacity="0.6" />
          <rect x="0" y="260" width="640" height="100" fill="#121329" />
        </svg>
      );
    default:
      // Warm Afternoon Bookshop Sunbeams
      return (
        <svg viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`s4-bg-${uid}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#4a2520" />
              <stop offset="55%" stopColor="#8c422c" />
              <stop offset="100%" stopColor="#d9823b" />
            </linearGradient>
          </defs>
          <rect width="640" height="360" fill={`url(#s4-bg-${uid})`} />
          <polygon points="140,0 280,0 460,360 240,360" fill="#fde68a" opacity="0.18" />
          <polygon points="340,0 460,0 620,360 450,360" fill="#fed7aa" opacity="0.15" />
          <rect x="0" y="265" width="640" height="95" fill="#291310" />
        </svg>
      );
  }
}

function ProjectCoverArtwork({
  project,
  index,
  uid,
}: {
  project: Project | null;
  index: number;
  uid: string;
}) {
  if (project?.coverImage) {
    return <img src={project.coverImage} alt={`${project.name} 封面`} />;
  }
  const variant = project ? getSceneVariant(project.name, index) : 1;
  return <DefaultSceneSvg variant={variant} uid={uid} />;
}

export function ProjectHome() {
  const navigate = useNavigate();

  const [projects, setProjects] = useState<Project[]>(() => loadProjectsFromStorage());
  const projectsRef = useRef<Project[]>(projects);

  const updateProjects = (updater: (prev: Project[]) => Project[]) => {
    setProjects((prev) => {
      const next = updater(prev);
      projectsRef.current = next;
      saveProjectsToStorage(next);
      return next;
    });
  };

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const [filter, setFilter] = useState<FilterKey>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(() => {
    try {
      return window.localStorage.getItem(HOME_THEME_STORAGE_KEY) === 'dark';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(HOME_THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
    } catch {
      // Keep theme switching available when browser storage is unavailable.
    }
  }, [isDark]);

  // Default seed is soft violet (matching the airy screenshot), with crimson/teal/amber one click away
  const [seedColor, setSeedColor] = useState<SeedColor>(() => {
    try {
      const saved = window.localStorage.getItem(SEED_STORAGE_KEY);
      if (saved === 'violet' || saved === 'crimson' || saved === 'teal' || saved === 'amber') {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'violet';
  });

  // Create & Edit modal states
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newCover, setNewCover] = useState('');
  const [newDirectory, setNewDirectory] = useState(() => loadAppSettings().defaultProjectDir);
  const [storage, setStorage] = useState<ProjectStorage | null>(() =>
    isTauri() ? null : { managed: false },
  );
  const [isCreating, setIsCreating] = useState(false);
  const creatingRef = useRef(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    if (!createOpen || !isTauri()) return;
    let active = true;
    void getProjectStorage()
      .then((result) => {
        if (active) setStorage(result);
      })
      .catch((error: unknown) => {
        if (active) setCreateError(`无法读取存储设置：${String(error)}`);
      });
    return () => {
      active = false;
    };
  }, [createOpen]);

  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editCover, setEditCover] = useState('');

  // Quick Hidden File Input for Direct Card Cover Upload
  const coverTargetProjectIdRef = useRef<string | null>(null);
  const quickCoverInputRef = useRef<HTMLInputElement | null>(null);

  // Opening & Error states
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const openingBusyRef = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.seed = seedColor;
    try {
      window.localStorage.setItem(SEED_STORAGE_KEY, seedColor);
    } catch {
      // ignore
    }
  }, [seedColor]);

  // Support Escape key to dismiss Create or Edit modal
  useEffect(() => {
    if (!createOpen && !editingProject) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCreating && !pickingDirectory) {
        if (createOpen) setCreateOpen(false);
        if (editingProject) setEditingProject(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [createOpen, editingProject, isCreating, pickingDirectory]);

  const activeProjects = useMemo(() => projects.filter((p) => !p.deleted), [projects]);
  const trashedProjects = useMemo(() => projects.filter((p) => Boolean(p.deleted)), [projects]);
  const favoriteProjects = useMemo(
    () => activeProjects.filter((p) => Boolean(p.isFavorite)),
    [activeProjects],
  );
  const recentProjects = useMemo(() => activeProjects.slice(0, 12), [activeProjects]);

  const counts = useMemo(
    () => ({
      all: activeProjects.length,
      favorites: favoriteProjects.length,
      recent: recentProjects.length,
      trash: trashedProjects.length,
    }),
    [activeProjects.length, favoriteProjects.length, recentProjects.length, trashedProjects.length],
  );

  const filtered = useMemo(() => {
    let base: Project[];
    switch (filter) {
      case 'favorites':
        base = favoriteProjects;
        break;
      case 'recent':
        base = recentProjects;
        break;
      case 'trash':
        base = trashedProjects;
        break;
      case 'all':
      default:
        base = activeProjects;
        break;
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.path ?? '').toLowerCase().includes(q),
    );
  }, [filter, favoriteProjects, recentProjects, trashedProjects, activeProjects, searchQuery]);

  const featuredProject = useMemo(() => {
    if (selectedProjectId) {
      const found = activeProjects.find((p) => p.id === selectedProjectId);
      if (found) return found;
    }
    return activeProjects[0] ?? null;
  }, [selectedProjectId, activeProjects]);

  const featuredIndex = useMemo(() => {
    if (!featuredProject) return 0;
    const idx = activeProjects.findIndex((p) => p.id === featuredProject.id);
    return idx >= 0 ? idx : 0;
  }, [featuredProject, activeProjects]);

  /**
   * Open a project card directly (preserving concurrent favorite/trash/delete mutations)
   */
  const handleOpenProjectCard = async (project: Project) => {
    if (project.deleted || openingBusyRef.current) return;
    openingBusyRef.current = true;
    setOpeningId(project.id);
    setErrorMessage(null);

    try {
      const targetPath = project.path || `/projects/${project.id}`;
      const info = await openProject(targetPath);

      const latest = projectsRef.current;
      const current = latest.find((p) => p.id === project.id);
      if (!current || current.deleted) {
        return;
      }

      const nextSceneCount =
        info && Array.isArray(info.scenes) && info.scenes.length > 0
          ? info.scenes.length
          : current.sceneCount;

      const updatedTime = formatNowTimestamp();

      updateProjects((prev) => {
        const latestItem = prev.find((p) => p.id === project.id);
        if (!latestItem || latestItem.deleted) return prev;
        const merged: Project = {
          ...latestItem,
          path: targetPath,
          sceneCount: nextSceneCount,
          lastModified: updatedTime,
        };
        return [merged, ...prev.filter((p) => p.id !== project.id)];
      });

      window.localStorage.setItem(`project-path-${project.id}`, targetPath);
      navigate(`/editor/${project.id}`);
    } catch {
      setErrorMessage(`无法打开项目「${project.name}」，请检查项目路径是否有效。`);
    } finally {
      openingBusyRef.current = false;
      setOpeningId(null);
    }
  };

  /**
   * Open an existing project folder via native dialog
   */
  const handleOpenExistingFolder = async () => {
    if (openingBusyRef.current) return;
    setErrorMessage(null);

    let selectedPath: string | string[] | null = null;
    try {
      selectedPath = await open({
        directory: true,
        multiple: false,
        title: '选择 WebGAL 项目文件夹',
      });
    } catch {
      setErrorMessage('无法打开项目文件夹选择器，请稍后重试。');
      return;
    }

    if (!selectedPath || Array.isArray(selectedPath)) return;

    openingBusyRef.current = true;
    const existingBefore = projectsRef.current.find((p) => p.path === selectedPath);
    const wasDeletedAtStart = Boolean(existingBefore?.deleted);
    if (existingBefore) setOpeningId(existingBefore.id);

    try {
      const info = await openProject(selectedPath);
      const latest = projectsRef.current;

      if (existingBefore) {
        const stillThere = latest.find((p) => p.id === existingBefore.id);
        if (!stillThere || (!wasDeletedAtStart && stillThere.deleted)) {
          return;
        }

        const nextSceneCount =
          info && Array.isArray(info.scenes) && info.scenes.length > 0
            ? info.scenes.length
            : stillThere.sceneCount;

        updateProjects((prev) => {
          const item = prev.find((p) => p.id === existingBefore.id);
          if (!item || (!wasDeletedAtStart && item.deleted)) return prev;
          const restored: Project = {
            ...item,
            deleted: false,
            path: selectedPath,
            sceneCount: nextSceneCount,
            lastModified: formatNowTimestamp(),
          };
          return [restored, ...prev.filter((p) => p.id !== existingBefore.id)];
        });

        window.localStorage.setItem(`project-path-${existingBefore.id}`, selectedPath);
        navigate(`/editor/${existingBefore.id}`);
      } else {
        const folderName = selectedPath.split(/[\\/]/).filter(Boolean).pop() || '未命名项目';
        const newId = `proj-${Date.now()}`;
        const created: Project = {
          id: newId,
          name: folderName,
          description: '',
          lastModified: formatNowTimestamp(),
          path: selectedPath,
          isFavorite: false,
          sceneCount: info && Array.isArray(info.scenes) ? info.scenes.length : 1,
        };
        updateProjects((prev) => [created, ...prev]);
        window.localStorage.setItem(`project-path-${newId}`, selectedPath);
        navigate(`/editor/${newId}`);
      }
    } catch {
      setErrorMessage('无法打开项目：读取工程目录失败。');
    } finally {
      openingBusyRef.current = false;
      setOpeningId(null);
    }
  };

  const handleToggleFavorite = (project: Project) => {
    updateProjects((prev) =>
      prev.map((p) => (p.id === project.id ? { ...p, isFavorite: !p.isFavorite } : p)),
    );
  };

  const handleMoveToTrash = (project: Project) => {
    updateProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, deleted: true } : p)));
  };

  const handleRestoreFromTrash = (project: Project) => {
    updateProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, deleted: false } : p)));
  };

  const handlePermanentDelete = (project: Project) => {
    updateProjects((prev) => prev.filter((p) => p.id !== project.id));
    window.localStorage.removeItem(`project-path-${project.id}`);
  };

  const handleOpenEditModal = (project: Project) => {
    setEditingProject(project);
    setEditName(project.name);
    setEditDesc(project.description);
    setEditCover(project.coverImage ?? '');
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject) return;
    const trimmed = editName.trim();
    if (!trimmed) return;
    const targetId = editingProject.id;
    updateProjects((prev) =>
      prev.map((p) =>
        p.id === targetId
          ? {
              ...p,
              name: trimmed,
              description: editDesc.trim(),
              coverImage: editCover.trim() || undefined,
              lastModified: formatNowTimestamp(),
            }
          : p,
      ),
    );
    setEditingProject(null);
  };

  const handlePickCreateDirectory = async () => {
    setCreateError('');
    setPickingDirectory(true);
    try {
      const selected = await open({
        title: '选择项目存储文件夹',
        directory: true,
        multiple: false,
        ...(newDirectory ? { defaultPath: newDirectory } : {}),
      });
      if (typeof selected === 'string') setNewDirectory(selected);
    } catch (error) {
      setCreateError(`无法选择文件夹：${String(error)}`);
    } finally {
      setPickingDirectory(false);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (
      !trimmed ||
      !storage ||
      (!storage.managed && !newDirectory) ||
      creatingRef.current ||
      pickingDirectory
    )
      return;
    creatingRef.current = true;
    setIsCreating(true);
    setCreateError('');
    try {
      const info = storage.managed
        ? await createManagedProject(trimmed)
        : await initProject(newDirectory, trimmed);
      const id = `project-${Date.now()}`;
      const created: Project = {
        id,
        name: info.config.Game_name || trimmed,
        description: newDesc.trim(),
        lastModified: formatNowTimestamp(),
        path: info.path,
        isFavorite: false,
        sceneCount: info.scenes.length,
        coverImage: newCover.trim() || undefined,
      };
      window.localStorage.setItem(`project-path-${id}`, info.path);
      updateProjects((prev) => [created, ...prev]);
      let memorySaveError: string | null = null;
      if (created.description) {
        try {
          await saveProjectMemory(info.path, {
            worldSetting: created.description,
            writingStyle: '',
            userPreferences: '',
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          // Keep the initialized project reachable instead of initializing it again on retry.
          memorySaveError = String(error);
        }
      }
      setNewName('');
      setNewDesc('');
      setNewCover('');
      setCreateOpen(false);
      if (memorySaveError !== null) {
        setErrorMessage(
          `项目已创建，但初始记忆保存失败：${memorySaveError}。可打开项目后在项目记忆中补充简介。`,
        );
        return;
      }
      navigate(`/editor/${id}?agent=workflow`);
    } catch (error) {
      setCreateError(`无法创建项目：${String(error)}`);
    } finally {
      creatingRef.current = false;
      setIsCreating(false);
    }
  };

  const readImageFileAsDataUrl = (file: File, onResult: (dataUrl: string) => void) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onResult(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleTriggerQuickCoverUpload = (projectId: string) => {
    coverTargetProjectIdRef.current = projectId;
    quickCoverInputRef.current?.click();
  };

  const handleQuickCoverFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetId = coverTargetProjectIdRef.current;
    if (!file || !targetId) return;
    readImageFileAsDataUrl(file, (dataUrl) => {
      updateProjects((prev) =>
        prev.map((p) => (p.id === targetId ? { ...p, coverImage: dataUrl } : p)),
      );
    });
    e.target.value = '';
  };

  return (
    <div className={`ph-root ${isDark ? 'dark' : ''}`} data-seed={seedColor}>
      {/* Hidden file input for 1-click custom card cover upload */}
      <input
        ref={quickCoverInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleQuickCoverFileChange}
      />

      {/* 1. Top Bar: 3 Separate Floating Pill Islands with Generous Whitespace */}
      <header className="ph-topbar">
        {/* Left Brand Pill */}
        <button type="button" className="ph-brand-island" aria-label="Ollaic GalGame Studio，返回首页" onClick={() => navigate('/')}>
          <span className="ph-brand-island__icon" aria-hidden="true">
            <Sparkles size={14} />
          </span>
          <span className="ph-brand-island__name">Ollaic</span>
          <span className="ph-brand-island__tag">GalGame Studio</span>
        </button>

        {/* Center Filter Tabs + Search Pill */}
        <div className="ph-center-island">
          <nav className="ph-filter-pills" aria-label="作品分类筛选">
            <button
              type="button"
              className={`ph-filter-pill ${filter === 'all' ? 'is-active' : ''}`}
              aria-label={`项目（${counts.all}）`}
              onClick={() => setFilter('all')}
            >
              <Folder size={13} />
              <span>全部项目</span>
              <span className="ph-filter-pill__count">{counts.all}</span>
            </button>

            <button
              type="button"
              className={`ph-filter-pill ${filter === 'favorites' ? 'is-active' : ''}`}
              aria-label={`收藏（${counts.favorites}）`}
              onClick={() => setFilter('favorites')}
            >
              <Star size={13} />
              <span>我的收藏</span>
              <span className="ph-filter-pill__count">{counts.favorites}</span>
            </button>

            <button
              type="button"
              className={`ph-filter-pill ${filter === 'recent' ? 'is-active' : ''}`}
              aria-label={`最近（${counts.recent}）`}
              onClick={() => setFilter('recent')}
            >
              <Clock size={13} />
              <span>最近编辑</span>
              <span className="ph-filter-pill__count">{counts.recent}</span>
            </button>

            <button
              type="button"
              className={`ph-filter-pill ${filter === 'trash' ? 'is-active' : ''}`}
              aria-label={`回收站（${counts.trash}）`}
              onClick={() => setFilter('trash')}
            >
              <Trash2 size={13} />
              <span>回收站</span>
              <span className="ph-filter-pill__count">{counts.trash}</span>
            </button>
          </nav>

          <span className="ph-island-divider" aria-hidden="true" />

          <div className="ph-search-pill">
            <Search size={13} className="ph-search-pill__icon" />
            <input
              type="search"
              role="searchbox"
              aria-label="搜索项目"
              placeholder="搜索作品、简介或路径..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="ph-search-pill__input"
            />
            {searchQuery && (
              <button
                type="button"
                className="ph-search-pill__clear"
                aria-label="清除搜索"
                onClick={() => setSearchQuery('')}
              >
                <X size={11} />
              </button>
            )}
          </div>
        </div>

        {/* Right Actions + Seed Dots + Theme Toggle */}
        <div className="ph-right-island">
          <button
            type="button"
            className="ph-action-pill"
            aria-label="打开已有项目"
            onClick={() => void handleOpenExistingFolder()}
          >
            <FolderOpen size={13} />
            <span>打开已有项目</span>
          </button>

          <button
            type="button"
            className="ph-action-pill"
            aria-label="新建项目"
            onClick={() => {
              setCreateError('');
              setCreateOpen(true);
            }}
          >
            <Plus size={14} />
            <span>新建项目</span>
          </button>

          <div className="ph-seed-island" role="group" aria-label="点缀主题色">
            <button
              type="button"
              className={`ph-seed-dot ph-seed-dot--violet ${seedColor === 'violet' ? 'is-active' : ''}`}
              onClick={() => setSeedColor('violet')}
              title="柔雾鸢尾 (Violet)"
              aria-label="柔雾鸢尾主题"
            />
            <button
              type="button"
              className={`ph-seed-dot ph-seed-dot--crimson ${seedColor === 'crimson' ? 'is-active' : ''}`}
              onClick={() => setSeedColor('crimson')}
              title="绯樱酒红 (Crimson)"
              aria-label="绯樱酒红主题"
            />
            <button
              type="button"
              className={`ph-seed-dot ph-seed-dot--teal ${seedColor === 'teal' ? 'is-active' : ''}`}
              onClick={() => setSeedColor('teal')}
              title="晴空青碧 (Teal)"
              aria-label="晴空青碧主题"
            />
            <button
              type="button"
              className={`ph-seed-dot ph-seed-dot--amber ${seedColor === 'amber' ? 'is-active' : ''}`}
              onClick={() => setSeedColor('amber')}
              title="暮光琥珀 (Amber)"
              aria-label="暮光琥珀主题"
            />
          </div>

          <button
            type="button"
            className="ph-theme-btn"
            onClick={() => setIsDark((d) => !d)}
            aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
            title={isDark ? '切换到浅色模式' : '切换到深色模式'}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </header>

      {/* 2. Centered Breathable Main Stage (居中留白主舞台) */}
      <main className="ph-stage-container">
        {/* Split White Hero Card (Left Visual Stage + Right White Info Panel) */}
        {featuredProject && (
          <section className="ph-hero-card" aria-label="项目详情">
            <div className="ph-hero-visual">
              <div className="ph-hero-visual__art">
                <ProjectCoverArtwork
                  project={featuredProject}
                  index={featuredIndex}
                  uid={`hero-${featuredProject.id}`}
                />
              </div>
            </div>

            <div className="ph-hero-info">
              <div className="ph-hero-info__top">
                <h1 className="ph-hero-title">{featuredProject.name}</h1>
                {featuredProject.description && (
                  <p className="ph-hero-desc">{featuredProject.description}</p>
                )}
                <div className="ph-hero-meta-chips">
                  <span className="ph-meta-chip">
                    <BookOpen size={11} />
                    {featuredProject.sceneCount} 个场景
                  </span>
                  {featuredProject.lastModified && (
                    <span className="ph-meta-chip">
                      <Clock size={11} />
                      {featuredProject.lastModified}
                    </span>
                  )}
                </div>
              </div>
              <div className="ph-hero-info__footer">
                <button
                  type="button"
                  className="ph-ink-cta"
                  onClick={() => void handleOpenProjectCard(featuredProject)}
                >
                  <Play size={12} fill="currentColor" />
                  <span>继续创作</span>
                </button>
                <button
                  type="button"
                  className="ph-soft-btn"
                  onClick={() => handleOpenEditModal(featuredProject)}
                >
                  <Pencil size={13} />
                  <span>编辑设定</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {/* 3. Bottom Works Gallery Shelf (支持自定义封面 + 恢复作品简介 description) */}
        <section className="ph-shelf" aria-label="作品列表">
          <div className="ph-shelf-bar">
            <div className="ph-shelf-bar__left">
              <h2 className="ph-shelf-heading">项目列表</h2>
            </div>

            <div className="ph-view-pills" role="group" aria-label="视图切换">
              <button
                type="button"
                className={`ph-view-pill ${viewMode === 'grid' ? 'is-active' : ''}`}
                aria-label="网格视图"
                title="网格视图"
                aria-pressed={viewMode === 'grid'}
                onClick={() => setViewMode('grid')}
              >
                <LayoutGrid size={13} />
              </button>
              <button
                type="button"
                className={`ph-view-pill ${viewMode === 'list' ? 'is-active' : ''}`}
                aria-label="列表视图"
                title="列表视图"
                aria-pressed={viewMode === 'list'}
                onClick={() => setViewMode('list')}
              >
                <List size={13} />
              </button>
            </div>
          </div>

          {openingId && (
            <div className="ph-banner ph-banner--opening" role="status">
              <span>
                <Loader2
                  size={14}
                  className="ph-spin"
                  style={{ display: 'inline', marginRight: 6 }}
                />
                正在打开作品工程...
              </span>
            </div>
          )}

          {errorMessage && (
            <div className="ph-banner ph-banner--error" role="alert">
              <span>{errorMessage}</span>
              <button
                type="button"
                className="ph-card__icon-btn"
                aria-label="关闭错误提示"
                onClick={() => setErrorMessage(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="ph-empty-state">
              <h3 className="ph-empty-state__title">
                {searchQuery
                  ? '没有找到匹配的项目'
                  : filter === 'trash'
                    ? '回收站是空的'
                    : '暂无项目'}
              </h3>
              <p className="ph-empty-state__desc">
                {searchQuery
                  ? '没有找到符合当前搜索词的作品，试试清除搜索词或切换分类。'
                  : filter === 'trash'
                    ? '回收站里暂时没有被移除的作品。'
                    : '可新建项目或打开已有项目。'}
              </p>
              {searchQuery ? (
                <button
                  type="button"
                  className="ph-ink-cta"
                  aria-label="清除搜索"
                  onClick={() => setSearchQuery('')}
                >
                  清除搜索
                </button>
              ) : null}
            </div>
          ) : (
            <div className={`ph-cards-row ${viewMode === 'list' ? 'ph-cards-row--list' : ''}`}>
              {filtered.map((project, idx) => {
                const isTrashed = Boolean(project.deleted);
                const isSelected = featuredProject?.id === project.id;

                return (
                  <article
                    key={project.id}
                    className={`ph-card ${isSelected ? 'is-selected' : ''}`}
                    onMouseEnter={() => {
                      if (!isTrashed) setSelectedProjectId(project.id);
                    }}
                  >
                    <button
                      type="button"
                      className="ph-card__open-btn"
                      aria-label={`打开项目 ${project.name}`}
                      disabled={isTrashed}
                      onFocus={() => {
                        if (!isTrashed) setSelectedProjectId(project.id);
                      }}
                      onClick={() => void handleOpenProjectCard(project)}
                    >
                      {/* Upper Artwork / Custom User Background */}
                      <div className="ph-card__visual">
                        <ProjectCoverArtwork
                          project={project}
                          index={idx}
                          uid={`card-${project.id}-${idx}`}
                        />
                        <span className="ph-card__scene-pill">
                          <BookOpen size={10} />
                          {project.sceneCount} 个场景
                        </span>
                      </div>

                      {/* Lower White Box with Title + Restored Description + Footer */}
                      <div className="ph-card__body">
                        <h3 className="ph-card__title">{project.name}</h3>
                        {project.description && (
                          <p className="ph-card__desc">{project.description}</p>
                        )}
                        <div className="ph-card__footer">
                          {project.path && (
                            <span className="ph-card__path" title={project.path}>
                              <MapPin size={10} />
                              <span>{project.path}</span>
                            </span>
                          )}
                          {project.lastModified && (
                            <span className="ph-card__time">{project.lastModified}</span>
                          )}
                        </div>
                      </div>
                    </button>

                    {/* Top-Right White Floating Action Pill */}
                    <div className="ph-card__actions">
                      {!isTrashed ? (
                        <>
                          <button
                            type="button"
                            className={`ph-card__icon-btn ${project.isFavorite ? 'is-starred' : ''}`}
                            aria-label={
                              project.isFavorite
                                ? `取消收藏 ${project.name}`
                                : `收藏 ${project.name}`
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleFavorite(project);
                            }}
                          >
                            <Star size={12} fill={project.isFavorite ? 'currentColor' : 'none'} />
                          </button>

                          <button
                            type="button"
                            className="ph-card__icon-btn"
                            aria-label={`更换封面 ${project.name}`}
                            title="自定义卡片背景图"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTriggerQuickCoverUpload(project.id);
                            }}
                          >
                            <ImageIcon size={12} />
                          </button>

                          <button
                            type="button"
                            className="ph-card__icon-btn"
                            aria-label={`编辑项目 ${project.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenEditModal(project);
                            }}
                          >
                            <Pencil size={12} />
                          </button>

                          <button
                            type="button"
                            className="ph-card__icon-btn ph-card__icon-btn--danger"
                            aria-label={`移入回收站 ${project.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveToTrash(project);
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="ph-card__icon-btn"
                            aria-label={`还原项目 ${project.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRestoreFromTrash(project);
                            }}
                          >
                            <RotateCcw size={12} />
                          </button>

                          <button
                            type="button"
                            className="ph-card__icon-btn ph-card__icon-btn--danger"
                            aria-label={`永久移除 ${project.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePermanentDelete(project);
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* Create New Project Dialog (with Custom Cover Support) */}
      {createOpen && (
        <div className="ph-modal-backdrop" role="dialog" aria-modal="true" aria-label="新建项目">
          <div className="ph-dialog-card">
            <h2 style={{ margin: '0 0 6px', fontFamily: 'var(--ph-font-display)', fontSize: 19 }}>
              新建项目
            </h2>
            <form onSubmit={(event) => void handleCreateSubmit(event)}>
              <fieldset className="ph-create-fields" disabled={isCreating}>
                <div className="ph-dialog-field">
                  <label htmlFor="ph-new-name" className="ph-dialog-label">
                    项目名称
                  </label>
                  <input
                    id="ph-new-name"
                    type="text"
                    className="ph-dialog-input"
                    placeholder="例如：下一站夏天"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="ph-dialog-field">
                  <label htmlFor="ph-new-directory" className="ph-dialog-label">
                    存储文件夹
                  </label>
                  {storage?.managed ? (
                    <input
                      id="ph-new-directory"
                      className="ph-dialog-input"
                      value="应用项目库"
                      readOnly
                    />
                  ) : (
                    <div className="ph-directory-picker">
                      <input
                        id="ph-new-directory"
                        className="ph-dialog-input"
                        value={newDirectory}
                        placeholder="选择文件夹"
                        title={newDirectory || undefined}
                        readOnly
                      />
                      <button
                        type="button"
                        className="ph-soft-btn"
                        aria-label="选择存储文件夹"
                        disabled={pickingDirectory || !storage}
                        onClick={() => void handlePickCreateDirectory()}
                      >
                        <FolderOpen size={14} />
                        选择文件夹
                      </button>
                    </div>
                  )}
                </div>

                <div className="ph-dialog-field">
                  <label htmlFor="ph-new-desc" className="ph-dialog-label">
                    项目简介
                  </label>
                  <textarea
                    id="ph-new-desc"
                    rows={3}
                    className="ph-dialog-textarea"
                    placeholder="写下这部作品的故事梗概或备忘..."
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                  />
                </div>

                <div className="ph-dialog-field">
                  <label className="ph-dialog-label">卡片封面背景（可选）</label>
                  <div className="ph-cover-picker">
                    {newCover && (
                      <div className="ph-cover-preview">
                        <img src={newCover} alt="封面预览" />
                      </div>
                    )}
                    <label className="ph-soft-btn" style={{ cursor: 'pointer' }}>
                      <ImageIcon size={13} />
                      <span>选择本地图片</span>
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) readImageFileAsDataUrl(file, setNewCover);
                        }}
                      />
                    </label>
                    {newCover && (
                      <button type="button" className="ph-soft-btn" onClick={() => setNewCover('')}>
                        恢复默认插画
                      </button>
                    )}
                  </div>
                </div>

                {createError && (
                  <p className="ph-create-error" role="alert">
                    {createError}
                  </p>
                )}
                <div
                  style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}
                >
                  <button
                    type="button"
                    className="ph-soft-btn"
                    onClick={() => setCreateOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="ph-ink-cta"
                    disabled={
                      !newName.trim() ||
                      !storage ||
                      (!storage.managed && !newDirectory) ||
                      pickingDirectory
                    }
                  >
                    {isCreating ? '创建中…' : '创建项目'}
                  </button>
                </div>
              </fieldset>
            </form>
          </div>
        </div>
      )}

      {/* Edit Project Info Dialog (with Custom Cover Support) */}
      {editingProject && (
        <div
          className="ph-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="编辑项目信息"
        >
          <div className="ph-dialog-card">
            <h2 style={{ margin: '0 0 6px', fontFamily: 'var(--ph-font-display)', fontSize: 19 }}>
              编辑项目信息
            </h2>
            <p
              style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--ph-on-surface-variant)' }}
            >
              修改作品名称、简介或自定义卡片背景封面。
            </p>
            <form onSubmit={handleEditSubmit}>
              <div className="ph-dialog-field">
                <label htmlFor="ph-edit-name" className="ph-dialog-label">
                  项目名称
                </label>
                <input
                  id="ph-edit-name"
                  type="text"
                  className="ph-dialog-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="ph-dialog-field">
                <label htmlFor="ph-edit-desc" className="ph-dialog-label">
                  项目简介
                </label>
                <textarea
                  id="ph-edit-desc"
                  rows={3}
                  className="ph-dialog-textarea"
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                />
              </div>

              <div className="ph-dialog-field">
                <label className="ph-dialog-label">卡片封面背景</label>
                <div className="ph-cover-picker">
                  {editCover && (
                    <div className="ph-cover-preview">
                      <img src={editCover} alt="封面预览" />
                    </div>
                  )}
                  <label className="ph-soft-btn" style={{ cursor: 'pointer' }}>
                    <ImageIcon size={13} />
                    <span>上传自定义背景</span>
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) readImageFileAsDataUrl(file, setEditCover);
                      }}
                    />
                  </label>
                  {editCover && (
                    <button type="button" className="ph-soft-btn" onClick={() => setEditCover('')}>
                      恢复默认插画
                    </button>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                <button
                  type="button"
                  className="ph-soft-btn"
                  onClick={() => setEditingProject(null)}
                >
                  取消
                </button>
                <button type="submit" className="ph-ink-cta" disabled={!editName.trim()}>
                  保存修改
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectHome;
