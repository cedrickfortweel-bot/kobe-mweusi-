import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { ApiError } from "./http.ts";

export interface AuthedRequest {
  user: { id: string; email?: string };
  url: string;
  publicKey: string;
}

export type StaffRole = "admin" | "support_agent";

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

export function authenticatedClient(
  request: Request,
  auth: AuthedRequest
): ReturnType<typeof createClient> {
  const authorization = request.headers.get("Authorization");
  if (!authorization) throw new ApiError(401, "Unauthorized.");
  return createClient(auth.url, auth.publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
}

export async function isStaff(service: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const { data, error } = await service
    .from("internal_user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "support_agent"])
    .limit(1);
  if (error) throw new ApiError(503, "Staff access could not be verified.");
  return Array.isArray(data) && data.length > 0;
}

export async function requireStaffPermission(
  request: Request,
  auth: AuthedRequest,
  service: ReturnType<typeof createClient>,
  permission: string
): Promise<StaffRole> {
  const { data: roles, error: roleError } = await service
    .from("internal_user_roles")
    .select("role")
    .eq("user_id", auth.user.id)
    .in("role", ["admin", "support_agent"]);
  if (roleError) throw new ApiError(503, "Staff access could not be verified.");

  const role = (roles || []).some(row => row.role === "admin")
    ? "admin"
    : (roles || []).some(row => row.role === "support_agent")
      ? "support_agent"
      : null;
  if (!role) throw new ApiError(403, "Staff access required.");

  const { data: allowed, error: permissionError } = await service.rpc("has_permission", {
    p_user: auth.user.id,
    p_permission: permission,
  });
  if (permissionError) throw new ApiError(503, "Staff permissions could not be verified.");
  if (allowed !== true) throw new ApiError(403, "You do not have permission to perform this action.");

  if (role === "admin") {
    const { data: requirement, error: requirementError } = await service
      .from("admin_mfa_requirements")
      .select("mfa_required")
      .eq("role", role)
      .maybeSingle();
    if (requirementError) throw new ApiError(503, "Admin MFA policy could not be verified.");

    if (requirement?.mfa_required !== false) {
      const userClient = authenticatedClient(request, auth);
      const { data: assurance, error: assuranceError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError) throw new ApiError(503, "Admin MFA status could not be verified.");
      if (assurance.currentLevel !== "aal2") {
        throw new ApiError(403, "Complete multi-factor authentication to continue.", "MFA_REQUIRED");
      }
    }
  }

  return role;
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
