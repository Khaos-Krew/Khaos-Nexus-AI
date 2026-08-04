import { SupabaseAuthVerifier, SupabaseRestClient } from "./supabase.js";

function safeServiceError(message, status, cause) {
  const error = new Error(message);
  error.status = status;
  error.code = status === 401 ? "AUTH_INVALID" : status === 403 ? "ACCESS_DENIED" : "SUPABASE_UNAVAILABLE";
  error.supabaseStatus = Number.isInteger(cause?.supabaseStatus) ? cause.supabaseStatus : null;
  return error;
}

export class SafeSupabaseAuthVerifier extends SupabaseAuthVerifier {
  async verify(accessToken) {
    try {
      return await super.verify(accessToken);
    } catch (error) {
      if (error?.status === 401) throw safeServiceError("Invalid or expired access token", 401, error);
      throw safeServiceError("Authentication service is unavailable", 503, error);
    }
  }
}

export class SafeSupabaseRestClient extends SupabaseRestClient {
  async request(path, options) {
    try {
      return await super.request(path, options);
    } catch (error) {
      if (error?.status === 401) throw safeServiceError("Authentication is required", 401, error);
      if (error?.status === 403) throw safeServiceError("Permission denied", 403, error);
      throw safeServiceError("Database service is temporarily unavailable", 503, error);
    }
  }
}
