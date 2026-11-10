import React, { useState, useEffect } from 'react';
import { Shield, Key, Eye, EyeOff, Loader2, AlertCircle, Lock } from 'lucide-react';

interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  mode?: string;
}

export const LoginGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkStatus = async () => {
    try {
      const res = await fetch('/api/auth/status');
      if (res.ok) {
        const data = await res.json();
        setAuthStatus(data);
      } else {
        // If status fails, assume not required or allow app to load
        setAuthStatus({ required: false, authenticated: true });
      }
    } catch {
      // In case of network error, don't hard block
      setAuthStatus({ required: false, authenticated: true });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkStatus();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: apiKey.trim() })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setAuthStatus({ required: true, authenticated: true });
      } else {
        if (res.status === 429) {
          setError('Слишком много попыток входа. Подождите 1 минуту.');
        } else if (res.status === 401) {
          setError('Неверный API-ключ. Проверьте правильность ввода.');
        } else {
          setError(data.error || 'Ошибка входа. Попробуйте еще раз.');
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Ошибка соединения с сервером.');
    } finally {
      setSubmitting(false);
    }
  };

  // While checking auth status, display dark minimal placeholder
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b0e14] flex items-center justify-center text-slate-400">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
      </div>
    );
  }

  // If auth is not required, or the user is authenticated, render the terminal application
  if (!authStatus?.required || authStatus?.authenticated) {
    return <>{children}</>;
  }

  // Otherwise, present high-grade secure login gate
  return (
    <div className="min-h-screen bg-[#080b10] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[#111622] border border-slate-800/80 rounded-2xl shadow-2xl p-8 backdrop-blur-md">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl flex items-center justify-center mb-4 text-emerald-400 shadow-lg shadow-emerald-950/40">
            <Shield className="w-7 h-7" />
          </div>
          <h1 className="text-xl font-bold text-white tracking-wide">
            Автономный Торговый Терминал
          </h1>
          <p className="text-xs text-slate-400 mt-1.5 max-w-xs">
            Сессионный доступ к квантовой торговой системе защищен API-ключом
          </p>
        </div>

        {error && (
          <div className="mb-5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-start gap-2.5 text-rose-300 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center justify-between">
              <span>API Ключ Доступа</span>
              <span className="text-[10px] text-slate-500">X-API-Key / API_KEY</span>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                <Key className="w-4 h-4" />
              </div>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Вставьте ваш API-ключ..."
                required
                autoFocus
                className="w-full pl-10 pr-10 py-2.5 bg-[#0b0e14] border border-slate-700/60 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/80 focus:ring-1 focus:ring-emerald-500/50 transition-all font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-200"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || !apiKey.trim()}
            className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-xl text-sm shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2 transition-all"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Проверка ключа...</span>
              </>
            ) : (
              <>
                <Lock className="w-4 h-4" />
                <span>Войти в систему</span>
              </>
            )}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-500">
          <span>Режим: HttpOnly Cookie</span>
          <span>12ч сессия</span>
        </div>
      </div>
    </div>
  );
};
