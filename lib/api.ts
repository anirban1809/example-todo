let token = '';

if (typeof window !== 'undefined') token = window.localStorage.getItem('app-token') ?? '';

export function setToken(value: string) {
  token = value;
  window.localStorage.setItem('app-token', value);
}

export function clearToken() {
  token = '';
  window.localStorage.removeItem('app-token');
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new Error(
      ((await response.json().catch(() => ({}))) as { error?: string }).error ??
        response.statusText,
    );
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}
