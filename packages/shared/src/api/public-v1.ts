import { z } from 'zod';
import {
  AspectRatioSchema,
  ColorSchema,
  CompositionSchema,
  ResolutionSchema,
} from '../composition/schema';
import {
  AssetSchema,
  AvatarSchema,
  PublicVideoSchema,
  TemplateIdSchema,
  TemplateSchema,
  VideoStatusSchema,
  VoiceSchema,
} from '../entities';
import { AvatarIdSchema, VoiceIdSchema, idOf } from '../ids';
import { LanguageCodeSchema, LocaleSchema } from '../languages';
import { PaginationQuerySchema, paginated } from '../pagination';
import { PlanIdSchema } from '../plans';
import { OkSchema, listOf, route } from './contract';

/* -------------------------------------------------------------------------------------------
 * Public developer API v1 (feature 9). Auth: `Authorization: Bearer plk_…`.
 * All resources are scoped to the workspace of the key. Completion is notified through signed
 * webhooks (`video.completed` / `video.failed`) configured in the app, or by polling
 * `GET /v1/videos/:videoId`.
 * ----------------------------------------------------------------------------------------- */

export const V1MeSchema = z.object({
  workspace: z.object({
    id: idOf('workspace'),
    name: z.string(),
    plan: PlanIdSchema,
    credits: z.number().int(),
  }),
  apiKey: z.object({ id: idOf('apiKey'), name: z.string(), prefix: z.string() }),
});

/**
 * Three ways to describe the video:
 *  - `script`:      one talking-avatar scene from plain text (simplest)
 *  - `template`:    a template (built-in or custom) with `{{variables}}` filled in
 *  - `composition`: a full Composition document
 */
export const V1VideoInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('script'),
    text: z.string().trim().min(1).max(5000),
    avatarId: AvatarIdSchema,
    voiceId: VoiceIdSchema,
    language: LocaleSchema.default('es'),
    aspect: AspectRatioSchema.default('16:9'),
    backgroundColor: ColorSchema.default('#101322'),
    subtitles: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('template'),
    templateId: TemplateIdSchema,
    variables: z.record(z.string(), z.string().max(500)).default({}),
  }),
  z.object({
    type: z.literal('composition'),
    composition: CompositionSchema,
    variables: z.record(z.string(), z.string().max(500)).default({}),
  }),
]);

export const V1CreateVideoBodySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  input: V1VideoInputSchema,
  resolution: ResolutionSchema.default('720p'),
  /** false = only create the draft (render later from the app). */
  render: z.boolean().default(true),
});

const v1VideoParams = z.object({ videoId: idOf('video') });

export const publicV1Routes = {
  me: route({
    method: 'GET',
    path: '/v1/me',
    auth: 'apiKey',
    feature: 9,
    tag: 'Public API v1',
    summary: 'Workspace and key the request is authenticated as',
    response: V1MeSchema,
  }),
  listAvatars: route({
    method: 'GET',
    path: '/v1/avatars',
    auth: 'apiKey',
    feature: 9,
    tag: 'Public API v1',
    summary: 'Avatars available to the workspace',
    response: listOf(AvatarSchema),
  }),
  listVoices: route({
    method: 'GET',
    path: '/v1/voices',
    auth: 'apiKey',
    feature: 9,
    tag: 'Public API v1',
    summary: 'Voices available to the workspace',
    query: z.object({ language: LanguageCodeSchema.optional() }),
    response: listOf(VoiceSchema),
  }),
  listTemplates: route({
    method: 'GET',
    path: '/v1/templates',
    auth: 'apiKey',
    feature: 9,
    tag: 'Public API v1',
    summary: 'Templates available to the workspace',
    response: listOf(TemplateSchema),
  }),
  createVideo: route({
    method: 'POST',
    path: '/v1/videos',
    auth: 'apiKey',
    feature: 9,
    tag: 'Public API v1',
    summary: 'Create a video and (by default) queue its render',
    body: V1CreateVideoBodySchema,
    response: PublicVideoSchema,
    status: 202,
    errors: ['INSUFFICIENT_CREDITS', 'PLAN_LIMIT_EXCEEDED', 'CONTENT_BLOCKED', 'UNPROCESSABLE'],
  }),
  listVideos: route({
    method: 'GET',
    path: '/v1/videos',
    auth: 'apiKey',
    feature: 9,
    tag: 'Public API v1',
    summary: 'Videos of the workspace, newest first',
    query: PaginationQuerySchema.extend({ status: VideoStatusSchema.optional() }),
    response: paginated(PublicVideoSchema),
  }),
  getVideo: route({
    method: 'GET',
    path: '/v1/videos/:videoId',
    auth: 'apiKey',
    feature: 9,
    tag: 'Public API v1',
    summary: 'Status, progress and output URLs of a video',
    params: v1VideoParams,
    response: PublicVideoSchema,
  }),
  deleteVideo: route({
    method: 'DELETE',
    path: '/v1/videos/:videoId',
    auth: 'apiKey',
    feature: 9,
    tag: 'Public API v1',
    summary: 'Delete a video and its files',
    params: v1VideoParams,
    response: OkSchema,
  }),
  uploadAsset: route({
    method: 'POST',
    path: '/v1/assets',
    auth: 'apiKey',
    feature: 9,
    tag: 'Public API v1',
    summary: 'Upload an image, video or audio file to use in compositions',
    multipart: {
      fileField: 'file',
      fields: z.object({ name: z.string().max(120).optional() }),
      description: 'multipart/form-data with one `file` part and an optional `name` field',
    },
    response: AssetSchema,
    status: 201,
    errors: ['PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'PLAN_LIMIT_EXCEEDED'],
  }),
} as const;
