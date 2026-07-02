import { auth } from "./firebase";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

async function authHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  return {
    "Content-Type": "application/json",
    "X-User-Id": user?.uid ?? "",
    "X-User-Email": user?.email ?? "",
  };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export const api = {
  // Profile
  getProfile: () => request<any>("/users/profile"),
  updateProfile: (data: any) =>
    request<any>("/users/profile", { method: "PUT", body: JSON.stringify(data) }),
  deleteMyAccount: () => request<any>("/users/me", { method: "DELETE" }),

  // Legal document URLs (used by Settings to open in in-app browser)
  legalPrivacyUrl: () => `${BASE}/api/legal/privacy`,
  legalTermsUrl: () => `${BASE}/api/legal/terms`,

  // Daily prompt
  dailyPrompt: () => request<any>("/daily-prompt"),

  // Generators
  generate: (type: string, body: any) =>
    request<any>(`/generate/${type}`, { method: "POST", body: JSON.stringify(body) }),

  // History
  listHistory: (savedOnly = false) =>
    request<any>(`/history${savedOnly ? "?saved_only=true" : ""}`),
  toggleSave: (id: string) =>
    request<any>(`/history/${id}/save`, { method: "POST" }),
  deleteHistory: (id: string) =>
    request<any>(`/history/${id}`, { method: "DELETE" }),

  // Composio LinkedIn (legacy alias of social/linkedin/* — kept for the result-card Post button)
  linkedinStatus: () => request<any>("/composio/linkedin/status"),
  linkedinConnect: () =>
    request<any>("/composio/linkedin/connect", { method: "POST" }),
  linkedinPost: (content: string) =>
    request<any>("/composio/linkedin/post", {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  // Generic social (LinkedIn / Facebook / Instagram)
  socialStatus: (platform: string) =>
    request<any>(`/social/${platform}/status`),
  socialConnect: (platform: string) =>
    request<any>(`/social/${platform}/connect`, { method: "POST" }),
  socialDisconnect: (platform: string) =>
    request<any>(`/social/${platform}/disconnect`, { method: "POST" }),
  socialAccounts: (platform: string) =>
    request<any>(`/social/${platform}/accounts`),
  socialAllAccounts: () => request<any>("/social/all-accounts"),
  deleteSocialAccount: (platform: string, id: string) =>
    request<any>(`/social/${platform}/accounts/${id}`, { method: "DELETE" }),
  linkAccountToCompany: (companyId: string, platform: string, connected_account_id: string | null) =>
    request<any>(`/companies/${companyId}/link-account`, {
      method: "POST",
      body: JSON.stringify({ platform, connected_account_id }),
    }),
  socialPost: async (platform: string, content: string, options?: { image_url?: string; image_b64?: string; image_mime?: string; connection_id?: string; page_id?: string; history_id?: string }) => {
    const res = await request<any>(`/social/${platform}/post`, {
      method: "POST",
      body: JSON.stringify({ content, ...(options || {}) }),
    });
    // Backend now returns 200 with {success:false, error} for provider failures so that
    // edge proxies don't rewrite a 5xx body into raw HTML. Surface them as exceptions
    // so existing call-sites display the friendly error text.
    if (res && res.success === false) {
      throw new Error(res.error || `Couldn't post to ${platform}.`);
    }
    return res;
  },

  // History detail + partial update (for images + selected_accounts persistence)
  getHistoryItem: (id: string) => request<any>(`/history/${id}`),
  patchHistoryItem: (id: string, patch: any) =>
    request<any>(`/history/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  // Image generation — pass history_id + variant_index so the image is persisted onto
  // the history doc and survives navigation.
  generatePostImage: (body: { hook?: string; body?: string; prompt?: string; history_id?: string; variant_index?: number }) =>
    request<any>("/generate/post-image", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Topic ideas
  topicIdeas: (angle?: string) =>
    request<any>("/generate/topic-ideas", { method: "POST", body: JSON.stringify({ angle }) }),

  // Companies
  listCompanies: () => request<any>("/companies"),
  createCompany: (body: any) => request<any>("/companies", { method: "POST", body: JSON.stringify(body) }),
  updateCompany: (id: string, body: any) => request<any>(`/companies/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteCompany: (id: string) => request<any>(`/companies/${id}`, { method: "DELETE" }),
  activateCompany: (id: string) => request<any>(`/companies/${id}/activate`, { method: "POST" }),

  // Scheduled posts
  schedulePost: (body: any) => request<any>("/scheduled", { method: "POST", body: JSON.stringify(body) }),
  listScheduled: () => request<any>("/scheduled"),
  cancelScheduled: (id: string) => request<any>(`/scheduled/${id}`, { method: "DELETE" }),

  // Company autofill
  companyAutofill: (company_name: string, company_website?: string) =>
    request<any>("/company/autofill", {
      method: "POST",
      body: JSON.stringify({ company_name, company_website }),
    }),

  // ---- Admin ----
  adminListUsers: () => request<any>("/admin/users"),
  adminGrantComp: (params: { email: string; duration_days?: number; until?: string; note?: string; tier?: string }) =>
    request<any>("/admin/grant-comp", { method: "POST", body: JSON.stringify(params) }),
  adminRevokeComp: (email: string) =>
    request<any>("/admin/revoke-comp", { method: "POST", body: JSON.stringify({ email }) }),
};
