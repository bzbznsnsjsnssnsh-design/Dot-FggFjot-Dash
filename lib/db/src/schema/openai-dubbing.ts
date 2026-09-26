import {
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const openAiDubbingJobs = pgTable("openai_dubbing_jobs", {
  jobId: text("job_id").primaryKey(),
  segmentId: text("segment_id").notNull().unique(),
  sourceUrl: text("source_url").notNull(),
  startTime: doublePrecision("start_time").notNull(),
  endTime: doublePrecision("end_time"),
  status: text("status").notNull().default("pending"),
  progress: text("progress").notNull().default("في الانتظار"),
  sttModel: text("stt_model").notNull(),
  translationModel: text("translation_model").notNull(),
  preparationModel: text("preparation_model").notNull(),
  analysisModel: text("analysis_model").notNull(),
  voice: text("voice").notNull(),
  requestedVideoRate: doublePrecision("requested_video_rate").notNull().default(1),
  videoRate: doublePrecision("video_rate").notNull().default(1),
  requestedAudioSpeed: doublePrecision("requested_audio_speed").notNull().default(1),
  audioSpeed: doublePrecision("audio_speed").notNull().default(1),
  manualOffset: doublePrecision("manual_offset").notNull().default(0),
  maxSegmentSeconds: doublePrecision("max_segment_seconds").notNull().default(45),
  originalText: text("original_text"),
  arabicText: text("arabic_text"),
  preparedText: text("prepared_text"),
  speechTimings: jsonb("speech_timings").$type<Array<{
    utteranceId: string;
    startTime: number;
    endTime: number;
    originalText: string;
    arabicText: string;
  }>>().notNull().default([]),
  synchronizationData: jsonb("synchronization_data").$type<Record<string, unknown>>().notNull().default({}),
  audioObjectKey: text("audio_object_key"),
  audioDuration: doublePrecision("audio_duration"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const insertOpenAiDubbingJobSchema = createInsertSchema(openAiDubbingJobs).omit({
  createdAt: true,
  updatedAt: true,
});

export type OpenAiDubbingJob = typeof openAiDubbingJobs.$inferSelect;
export type InsertOpenAiDubbingJob = z.infer<typeof insertOpenAiDubbingJobSchema>;

export const openAiDubbingMedia = pgTable("openai_dubbing_media", {
  mediaId: text("media_id").primaryKey(),
  objectKey: text("object_key").notNull().unique(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  duration: doublePrecision("duration"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const insertOpenAiDubbingMediaSchema = createInsertSchema(openAiDubbingMedia).omit({
  createdAt: true,
});

export type OpenAiDubbingMedia = typeof openAiDubbingMedia.$inferSelect;
export type InsertOpenAiDubbingMedia = z.infer<typeof insertOpenAiDubbingMediaSchema>;