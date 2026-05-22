const { z } = require("zod");

const leadSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  websiteUrl: z.string().trim().url(),
  industry: z.string().trim().min(2).max(100),
  companyDescription: z.string().trim().min(20).max(2000),
  linkedInSummary: z.string().trim().max(2000).optional().default(""),
  prospectContextDetails: z.string().trim().max(800).optional().default(""),
  operationalArea: z.string().trim().max(200).optional().default(""),
  painHypothesis: z.string().trim().min(10).max(800),
  targetPersona: z.string().trim().min(2).max(120),
  yourServiceAngle: z.string().trim().min(10).max(800),
  productOrService: z.string().trim().max(800).optional().default(""),
  primaryOutcome: z.string().trim().max(800).optional().default(""),
  frontEndOfferDeliverable: z.string().trim().max(800).optional().default(""),
  timeOrEffortConstraint: z.string().trim().max(200).optional().default(""),
  objectionToPreHandle: z.string().trim().max(800).optional().default(""),
});

const draftRequestSchema = z.object({ lead: leadSchema });
const subjectRequestSchema = z.object({
  lead: leadSchema,
  draftBody: z.string().trim().min(20).max(3000).optional(),
});
const generateRequestSchema = z.object({ lead: leadSchema });

const campaignUploadSchema = z.object({
  campaignFile: z.object({
    name: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().max(200).optional().default("application/octet-stream"),
    contentBase64: z.string().trim().min(1),
  }),
  count: z.coerce.number().int().min(1).max(1000000),
});

const mailerDocRequestSchema = z.object({
  campaignId: z.string().trim().min(1).max(200),
  rowNumber: z.coerce.number().int().min(2).max(1000000),
  websiteUrl: z.string().trim().max(2000).optional().default(""),
  jinaContent: z.string().trim().max(100000).optional().default(""),
  sourceRow: z.record(z.unknown()).optional().default({}),
});

const campaignSendPreviewRequestSchema = z.object({
  campaignId: z.string().trim().min(1).max(200),
  rowNumber: z.coerce.number().int().min(2).max(1000000),
  websiteUrl: z.string().trim().max(2000).optional().default(""),
  jinaContent: z.string().trim().max(100000).optional().default(""),
  sourceRow: z.record(z.unknown()).optional().default({}),
  contactEmail: z.string().trim().email().optional(),
  draftIterations: z.coerce.number().int().min(1).max(20).optional().default(1),
});

const campaignSendRequestSchema = z.object({
  campaignId: z.string().trim().min(1).max(200),
  rowNumber: z.coerce.number().int().min(2).max(1000000),
  to: z.string().trim().email(),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(100000),
  senderEmail: z.string().trim().email().optional(),
  senderName: z.string().trim().max(200).optional(),
  enforceDomainBulkLimit: z.coerce.boolean().optional().default(false),
  mailerFields: z.record(z.unknown()).optional(),
});

const campaignDeleteRowsRequestSchema = z.object({
  rowNumbers: z
    .array(z.coerce.number().int().min(2).max(1000000))
    .min(1)
    .max(100000),
});

module.exports = {
  leadSchema,
  draftRequestSchema,
  subjectRequestSchema,
  generateRequestSchema,
  campaignUploadSchema,
  mailerDocRequestSchema,
  campaignSendPreviewRequestSchema,
  campaignSendRequestSchema,
  campaignDeleteRowsRequestSchema,
};
