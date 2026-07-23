import { z } from 'zod';

export const RunRequestSchema = z.object({
  projectId: z.uuid(),
  requestedBy: z.enum(['desktop', 'cli', 'mcp', 'resume']).default('desktop'),
  resumeRunId: z.uuid().optional(),
});

export const DoctorCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  detail: z.string(),
  source: z.string(),
  checkedAt: z.iso.datetime(),
});

export const DoctorReportSchema = z.object({
  status: z.enum(['ready', 'degraded', 'blocked']),
  checks: z.array(DoctorCheckSchema),
  checkedAt: z.iso.datetime(),
});

export type RunRequest = z.infer<typeof RunRequestSchema>;
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
