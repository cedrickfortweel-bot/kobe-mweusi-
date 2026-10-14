import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { ApiError } from "./http.ts";

export interface AuthedRequest {
  user: { id: string; email?: string };
  url: string;
  publicKey: string;
}

/* Verify the caller's access token with the publishable key. Every
   Kobe endpoint runs this first; role checks happen per action. */
export async function verifyUser(request: Request): Promise<AuthedRequest> {
  const url = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const authorization = request.headers.get("Authorization");
  if (!url || !publicKey || !authorization) throw new ApiError(401, "Unauthorized");

  const client = createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new ApiError(401, "Unauthorized");
  return { user: { id: data.user.id, email: data.user.email }, url: url as string, publicKey: publicKey as string };
}

export function serviceClient(url: string): ReturnType<typeof createClient> {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function isStaff(service: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const { data } = await service
    .from("internal_user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "support_agent"])
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

/* Look up a profile row (account_type, display_name, phone) for a user id. */
export async function profileOf(
  service: ReturnType<typeof createClient>,
  userId: string
): Promise<{ id: string; account_type: string; display_name: string; phone_e164: string | null } | null> {
  const { data } = await service
    .from("profiles")
    .select("id,account_type,display_name,phone_e164")
    .eq("id", userId)
    .maybeSingle();
  return data as ReturnType<typeof profileOf> extends Promise<infer R> ? R : never;
}
