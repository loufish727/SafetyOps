import { createFeedbackHandler } from "./handler.ts";

function defaultPlatformKey(name: string): string | undefined {
  try {
    const value = JSON.parse(Deno.env.get(name) ?? "{}")?.default;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

Deno.serve(createFeedbackHandler({
  allowedOrigins: (Deno.env.get("SAFETYOPS_FEEDBACK_ALLOWED_ORIGINS") ?? "")
    .split(",").map((origin) => origin.trim()).filter(Boolean),
  companyId: Deno.env.get("SAFETYOPS_FEEDBACK_COMPANY_ID") ?? "",
  recipient: Deno.env.get("SAFETYOPS_FEEDBACK_TO") ?? "",
  scriptUrl: Deno.env.get("SAFETYOPS_FEEDBACK_GOOGLE_SCRIPT_URL") ?? "",
  scriptSecret: Deno.env.get("SAFETYOPS_FEEDBACK_GOOGLE_SCRIPT_SECRET") ?? "",
  supabaseUrl: (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, ""),
  publicKey: Deno.env.get("SAFETYOPS_SUPABASE_PUBLISHABLE_KEY") ??
    defaultPlatformKey("SUPABASE_PUBLISHABLE_KEYS") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  serviceKey: Deno.env.get("SAFETYOPS_SUPABASE_SECRET_KEY") ??
    defaultPlatformKey("SUPABASE_SECRET_KEYS") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
}));
