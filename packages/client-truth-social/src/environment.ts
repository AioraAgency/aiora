import { IAgentRuntime } from "@ai16z/eliza";
import { z } from "zod";
import type { ProcessEnv } from 'node';
declare const process: { env: ProcessEnv };

export const DEFAULT_MAX_TRUTH_LENGTH = 280;

export const truthEnvSchema = z.object({
    TRUTHSOCIAL_DRY_RUN: z
        .string()
        .transform((val) => val.toLowerCase() === "true"),
    TRUTHSOCIAL_USERNAME: z.string().min(1, "Truth Social username is required"),
    TRUTHSOCIAL_PASSWORD: z.string().min(1, "Truth Social password is required"),
    MAX_TRUTH_LENGTH: z
        .string()
        .pipe(z.coerce.number().min(0).int())
        .default(DEFAULT_MAX_TRUTH_LENGTH.toString()),
    POST_INTERVAL_MIN: z
        .string()
        .pipe(z.coerce.number().min(0).int())
        .default("90"),
    POST_INTERVAL_MAX: z
        .string()
        .pipe(z.coerce.number().min(0).int())
        .default("180"),
    ACTION_INTERVAL: z
        .string()
        .pipe(z.coerce.number().min(0).int())
        .default("300000"), // 5 minutes
    ENABLE_ACTION_PROCESSING: z
        .string()
        .transform((val) => val.toLowerCase() === "true")
        .default("true"),
});

export type TruthConfig = z.infer<typeof truthEnvSchema>;

export async function validateTruthConfig(runtime: IAgentRuntime): Promise<TruthConfig> {
    try {
        const config = {
            TRUTHSOCIAL_DRY_RUN: runtime.getSetting("TRUTHSOCIAL_DRY_RUN") || process.env.TRUTHSOCIAL_DRY_RUN || "false",
            TRUTHSOCIAL_USERNAME: runtime.getSetting("TRUTHSOCIAL_USERNAME") || process.env.TRUTHSOCIAL_USERNAME,
            TRUTHSOCIAL_PASSWORD: runtime.getSetting("TRUTHSOCIAL_PASSWORD") || process.env.TRUTHSOCIAL_PASSWORD,
            MAX_TRUTH_LENGTH: runtime.getSetting("MAX_TRUTH_LENGTH") || process.env.MAX_TRUTH_LENGTH || DEFAULT_MAX_TRUTH_LENGTH.toString(),
            POST_INTERVAL_MIN: runtime.getSetting("POST_INTERVAL_MIN") || process.env.POST_INTERVAL_MIN || "90",
            POST_INTERVAL_MAX: runtime.getSetting("POST_INTERVAL_MAX") || process.env.POST_INTERVAL_MAX || "180",
            ACTION_INTERVAL: runtime.getSetting("ACTION_INTERVAL") || process.env.ACTION_INTERVAL || "300000",
            ENABLE_ACTION_PROCESSING: runtime.getSetting("ENABLE_ACTION_PROCESSING") || process.env.ENABLE_ACTION_PROCESSING || "true",
        };

        return truthEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(`Truth Social configuration validation failed:\n${errorMessages}`);
        }
        throw error;
    }
}