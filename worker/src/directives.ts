import { z } from "zod";
import YAML from "yaml";

export const DirectiveCommandSchema = z
  .object({
    argv: z.array(z.string()).optional(),
    argv_list: z.array(z.array(z.string())).optional()
  })
  .refine((v) => !!v.argv || !!v.argv_list, {
    message: "command must have argv or argv_list"
  });

export const RuleSchema = z.object({
  condition: z.string(),
  action: z.enum(["permit", "deny"]),
  command: DirectiveCommandSchema
});

export const FieldSchema = z
  .object({
    type: z.enum(["text", "select"]).optional().default("text"),
    description: z.string().optional().default(""),
    multiple: z.boolean().optional(),
    options: z.any().optional()
  })
  .passthrough();

export const DirectiveSchema = z.object({
  name: z.string(),
  rules: z.array(RuleSchema),
  field: FieldSchema
});

export const DirectivesFileSchema = z.record(DirectiveSchema);

export type DirectivesFile = z.infer<typeof DirectivesFileSchema>;
export type Directive = z.infer<typeof DirectiveSchema>;

export function parseDirectivesYaml(yamlText: string): DirectivesFile {
  const doc = YAML.parse(yamlText);
  return DirectivesFileSchema.parse(doc);
}
