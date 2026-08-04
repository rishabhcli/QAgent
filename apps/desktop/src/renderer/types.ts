import type {
  ArtifactPreview,
  BootstrapSnapshot,
  DoctorReport,
  ProjectInspection,
  RunDetail,
} from '@qagent/contracts';

export type RunDetailData = RunDetail;
export type DetectedProjectData = ProjectInspection;

export type AppView = 'projects' | 'runs' | 'tests' | 'settings';

export type { ArtifactPreview, BootstrapSnapshot, DoctorReport };
