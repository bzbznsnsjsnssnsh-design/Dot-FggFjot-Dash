import { randomUUID } from "crypto";

export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface Job {
  jobId: string;
  status: JobStatus;
  progress: string;
  audioPath: string | null;
  transcript: string | null;
  translation: string | null;
  error: string | null;
  startTime: number | null;
  createdAt: number;
}

const jobs = new Map<string, Job>();

const MAX_JOBS = 100;
const JOB_TTL_MS = 30 * 60 * 1000;

function cleanOldJobs() {
  const now = Date.now();
  if (jobs.size > MAX_JOBS) {
    const sorted = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of sorted.slice(0, jobs.size - MAX_JOBS)) {
      jobs.delete(id);
    }
  }
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

export function createJob(startTime: number): Job {
  cleanOldJobs();
  const jobId = randomUUID();
  const job: Job = {
    jobId,
    status: "pending",
    progress: "في الانتظار...",
    audioPath: null,
    transcript: null,
    translation: null,
    error: null,
    startTime,
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function updateJob(jobId: string, updates: Partial<Job>) {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, updates);
    jobs.set(jobId, job);
  }
}
