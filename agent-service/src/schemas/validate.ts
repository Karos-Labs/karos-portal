import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { TASK_TYPES, type JobRequest, type TaskType } from "../types.js";
import socialPost from "./task-types/social_post.json" with { type: "json" };
import newsletterIssue from "./task-types/newsletter_issue.json" with { type: "json" };
import blogArticle from "./task-types/blog_article.json" with { type: "json" };
import landingPage from "./task-types/landing_page.json" with { type: "json" };

export const MAX_CONTEXT_FILES = 20;
export const MAX_CONTEXT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CONTEXT_TOTAL_BYTES = 100 * 1024 * 1024;

const baseRequestSchema = {
  $id: "job-request",
  type: "object",
  additionalProperties: false,
  required: ["task_type", "client_id", "brief", "callback_url"],
  properties: {
    task_type: { type: "string", enum: [...TASK_TYPES] },
    client_id: { type: "string", minLength: 1, maxLength: 200 },
    client_slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    brief: { type: "object" },
    callback_url: { type: "string", format: "uri", pattern: "^https?://" },
    agent_version: { type: "string", maxLength: 100, pattern: "^[\\w./-]+$" },
    context_files: {
      type: "array",
      maxItems: MAX_CONTEXT_FILES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "url"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^/\\\\]+$" },
          url: { type: "string", format: "uri", pattern: "^https://" },
          description: { type: "string", maxLength: 1000 },
          content_type: { type: "string", maxLength: 200 },
        },
      },
    },
    metadata: {
      type: "object",
      maxProperties: 20,
      additionalProperties: { type: "string", maxLength: 500 },
    },
  },
} as const;

const briefSchemas: Record<TaskType, object> = {
  social_post: socialPost,
  newsletter_issue: newsletterIssue,
  blog_article: blogArticle,
  landing_page: landingPage,
};

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: false });
addFormats.default ? addFormats.default(ajv) : (addFormats as unknown as (a: Ajv) => void)(ajv);

const validateBase: ValidateFunction = ajv.compile(baseRequestSchema);
const validateBrief: Record<TaskType, ValidateFunction> = Object.fromEntries(
  (Object.entries(briefSchemas) as Array<[TaskType, object]>).map(([taskType, schema]) => [
    taskType,
    ajv.compile(schema),
  ]),
) as Record<TaskType, ValidateFunction>;

export type ValidationResult = { ok: true; request: JobRequest } | { ok: false; errors: string[] };

function formatErrors(validate: ValidateFunction, prefix: string): string[] {
  return (validate.errors ?? []).map((e) => `${prefix}${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

export function validateJobRequest(body: unknown): ValidationResult {
  if (!validateBase(body)) return { ok: false, errors: formatErrors(validateBase, "") };
  const request = body as JobRequest;
  const briefValidator = validateBrief[request.task_type];
  if (!briefValidator(request.brief)) {
    return { ok: false, errors: formatErrors(briefValidator, "/brief") };
  }
  return { ok: true, request };
}
