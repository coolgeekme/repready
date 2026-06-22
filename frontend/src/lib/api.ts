import { auth } from "./firebase";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

async function authHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  return {
    "Content-Type": "application/json",
    "X-User-Id": user?.uid ?? "",
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

  // Composio LinkedIn
  linkedinStatus: () => request<any>("/composio/linkedin/status"),
  linkedinConnect: () =>
    request<any>("/composio/linkedin/connect", { method: "POST" }),
  linkedinPost: (content: string) =>
    request<any>("/composio/linkedin/post", {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  // Image generation
  generatePostImage: (body: { hook?: string; body?: string; prompt?: string }) =>
    request<any>("/generate/post-image", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Company autofill
  companyAutofill: (company_name: string, company_website?: string) =>
    request<any>("/company/autofill", {
      method: "POST",
      body: JSON.stringify({ company_name, company_website }),
    }),
};
