const AUTH_BASE = import.meta.env.VITE_AUTH_BASE || "https://jcvolpe.me";
const APP_NAME = import.meta.env.VITE_APP_NAME || "y2k";
const DEFAULT_REQUIRED = import.meta.env.DEV ? "false" : "true";
const AUTH_REQUIRED =
  (import.meta.env.VITE_AUTH_REQUIRED || DEFAULT_REQUIRED).toLowerCase() !==
  "false";
const TOKEN_SKEW_MS = 60_000;

type TokenState = {
  value: string;
  expMs: number;
};

let tokenState: TokenState | null = null;
let tokenPromise: Promise<string | null> | null = null;

const toBase64 = (value: string) => value.replace(/-/g, "+").replace(/_/g, "/");

const decodeJwtExp = (token: string) => {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(toBase64(parts[1])));
    if (typeof payload?.exp === "number") {
      return payload.exp * 1000;
    }
  } catch {
    // Ignore invalid payloads.
  }
  return null;
};

const redirectToSignIn = () => {
  if (typeof window === "undefined") return;
  const callbackUrl = encodeURIComponent(window.location.href);
  window.location.href = `${AUTH_BASE}/api/auth/signin?callbackUrl=${callbackUrl}`;
};

const fetchToken = async () => {
  try {
    const res = await fetch(`${AUTH_BASE}/api/apps/token`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: APP_NAME }),
    });
    if (res.status === 401 || res.status === 403) {
      redirectToSignIn();
      return null;
    }
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      return null;
    }
    const expMs = decodeJwtExp(data.token) || Date.now() + 5 * 60_000;
    tokenState = { value: data.token, expMs };
    return tokenState.value;
  } catch {
    redirectToSignIn();
    return null;
  }
};

export const initAuth = async () => {
  if (typeof window === "undefined" || !AUTH_REQUIRED) return;
  await fetchToken();
};

export const isAuthRequired = () => AUTH_REQUIRED;

export const getAuthToken = async () => {
  if (typeof window === "undefined" || !AUTH_REQUIRED) return null;
  if (tokenState && Date.now() < tokenState.expMs - TOKEN_SKEW_MS) {
    return tokenState.value;
  }
  if (!tokenPromise) {
    tokenPromise = fetchToken().finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
};

export const getAuthHeader = async () => {
  if (!AUTH_REQUIRED) return {};
  const token = await getAuthToken();
  if (!token) {
    throw new Error("Authentication required.");
  }
  return { Authorization: `Bearer ${token}` };
};
