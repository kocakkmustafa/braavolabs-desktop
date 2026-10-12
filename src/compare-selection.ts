import { z } from "zod";

export const reasoningEffortSchema = z.enum(["low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export interface ModelSelection { provider: string; model: string; reasoningEffort?: ReasoningEffort }

const optionSchema = z.object({
  provider: z.string().min(1), model: z.string().min(1),
  reasoningEfforts: z.array(reasoningEffortSchema),
});
const optionsSchema = z.object({
  companyId: z.string().min(1), maxCandidates: z.number().int().min(1).max(3),
  selections: z.array(optionSchema),
});
export type CompareSelectionOption = z.infer<typeof optionSchema>;
export type CompareSelectionOptions = z.infer<typeof optionsSchema>;

/** Metadata is advisory. The selected endpoint revalidates ownership/capability. */
export function parseCompareSelectionOptions(raw: unknown, companyId: string): CompareSelectionOptions {
  const options = optionsSchema.parse(raw);
  if (options.companyId !== companyId) throw Error("Mismatched compare company");
  const keys = options.selections.map(s => JSON.stringify([s.provider, s.model]));
  if (new Set(keys).size !== keys.length) throw Error("Ambiguous compare models");
  return options;
}
