'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type PropsWithChildren,
} from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { clearToken, setToken } from '@/lib/api';

interface AuthConfig {
  userPoolId: string;
  userPoolClientId: string;
  local: boolean;
}
interface AuthValue {
  ready: boolean;
  signedIn: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  confirm(email: string, code: string): Promise<void>;
  signOut(): void;
}
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    void fetch('/api/config')
      .then((response) => response.json() as Promise<AuthConfig>)
      .then((value) => {
        setConfig(value);
        if (value.local) return setSignedIn(true);
        const pool = new CognitoUserPool({
          UserPoolId: value.userPoolId,
          ClientId: value.userPoolClientId,
        });
        const user = pool.getCurrentUser();
        if (user)
          user.getSession((error: Error | null, session: CognitoUserSession) => {
            if (!error && session.isValid()) {
              setToken(session.getAccessToken().getJwtToken());
              setSignedIn(true);
            }
          });
      });
  }, []);
  const pool = useMemo(
    () =>
      config && !config.local
        ? new CognitoUserPool({
            UserPoolId: config.userPoolId,
            ClientId: config.userPoolClientId,
          })
        : null,
    [config],
  );
  const value: AuthValue = {
    ready: Boolean(config),
    signedIn,
    signIn: async (email, password) => {
      if (!pool) return setSignedIn(true);
      const user = new CognitoUser({ Username: email, Pool: pool });
      await new Promise<void>((resolve, reject) =>
        user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
          onSuccess: (session) => {
            setToken(session.getAccessToken().getJwtToken());
            setSignedIn(true);
            resolve();
          },
          onFailure: reject,
        }),
      );
    },
    signUp: async (email, password) => {
      if (!pool) return;
      await new Promise<void>((resolve, reject) =>
        pool.signUp(
          email,
          password,
          [new CognitoUserAttribute({ Name: 'email', Value: email })],
          [],
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    },
    confirm: async (email, code) => {
      if (!pool) return;
      const user = new CognitoUser({ Username: email, Pool: pool });
      await new Promise<void>((resolve, reject) =>
        user.confirmRegistration(code, true, (error) => (error ? reject(error) : resolve())),
      );
    },
    signOut: () => {
      pool?.getCurrentUser()?.signOut();
      clearToken();
      setSignedIn(false);
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth requires AuthProvider');
  return value;
}

export function AuthGate({ children }: PropsWithChildren) {
  const auth = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup' | 'confirm'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  if (!auth.ready)
    return <main className="grid min-h-screen place-items-center text-zinc-400">Preparing…</main>;
  if (auth.signedIn) return children;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    try {
      if (mode === 'signin') await auth.signIn(email, password);
      else if (mode === 'signup') {
        await auth.signUp(email, password);
        setMode('confirm');
      } else {
        await auth.confirm(email, code);
        setMessage('Email confirmed. You can now sign in.');
        setMode('signin');
      }
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Authentication failed');
    }
  }

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-7"
        onSubmit={submit}
      >
        <h1 className="text-2xl font-bold">
          {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Confirm email'}
        </h1>
        <input
          className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        {mode !== 'confirm' && (
          <input
            className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        )}
        {mode === 'confirm' && (
          <input
            className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3"
            inputMode="numeric"
            placeholder="Confirmation code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        )}
        {message && <p className="text-sm text-amber-300">{message}</p>}
        <button className="w-full rounded-xl bg-emerald-400 px-4 py-3 font-bold text-zinc-950">
          {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Sign up' : 'Confirm email'}
        </button>
        <button
          type="button"
          className="w-full text-sm text-zinc-400"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        >
          {mode === 'signin' ? 'Create an account' : 'Back to sign in'}
        </button>
      </form>
    </main>
  );
}
