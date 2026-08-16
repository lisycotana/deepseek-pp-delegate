import { useCallback, useEffect, useState } from 'react';
import { sidepanelRuntimeClient } from '../runtime-client';
import { useI18n } from '../i18n';

/** The DS web model mode the delegate runs under. */
type ModelType = 'default' | 'expert' | 'vision';

/** Status snapshot returned by GET_DELEGATE_STATUS. */
interface DelegateStatus {
  running: boolean;
  runId?: string;
  tasksCompleted: number;
  lastError?: string;
  lastStoppedAt?: number;
}

/** Start-result shape from START_DELEGATE. */
type StartResult = { ok: true; runId: string } | { ok: false; error: string };

/**
 * The Delegate sub-page: a visible control for the browser-side delegate loop.
 *
 * Replaces the DevTools-console `chrome.runtime.sendMessage({ type: 'START_DELEGATE' })`
 * incantation with a button. The model mode and web-search toggle travel in the
 * start payload, so a user picks them here rather than editing the console call.
 */
export default function DelegatePage(): React.ReactElement {
  const { t } = useI18n();
  const [status, setStatus] = useState<DelegateStatus | null>(null);
  const [modelType, setModelType] = useState<ModelType>('default');
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll status every 2s while the page is open. The loop runs in the
  // background service worker, so the UI reflects its state through polling.
  const refresh = useCallback(async () => {
    try {
      const result = await sidepanelRuntimeClient.request({ type: 'GET_DELEGATE_STATUS' }) as DelegateStatus;
      setStatus(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 2_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await sidepanelRuntimeClient.request({
        type: 'START_DELEGATE',
        payload: {
          maxTasks: undefined,
          modelType: modelType === 'default' ? null : modelType,
          searchEnabled,
        },
      }) as StartResult;
      if (!result.ok) {
        setError(result.error);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [modelType, searchEnabled, refresh]);

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await sidepanelRuntimeClient.request({ type: 'STOP_DELEGATE' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const running = status?.running === true;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header>
        <h2 className="text-lg font-semibold">{t('sidepanel.delegatePage.title')}</h2>
        <p className="text-sm opacity-70 mt-1">{t('sidepanel.delegatePage.description')}</p>
      </header>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('sidepanel.delegatePage.modelMode')}</h3>
        <div className="flex flex-col gap-1">
          {(['default', 'expert', 'vision'] as ModelType[]).map((mode) => (
            <label key={mode} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="modelType"
                checked={modelType === mode}
                disabled={running || busy}
                onChange={() => setModelType(mode)}
              />
              <span>{t(`sidepanel.delegatePage.modes.${mode}` as never)}</span>
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm mt-1">
          <input
            type="checkbox"
            checked={searchEnabled}
            disabled={running || busy}
            onChange={(e) => setSearchEnabled(e.target.checked)}
          />
          <span>{t('sidepanel.delegatePage.webSearch')}</span>
        </label>
      </section>

      <section className="flex gap-2">
        {running ? (
          <button
            type="button"
            onClick={stop}
            disabled={busy}
            className="px-4 py-2 rounded bg-red-600 text-white text-sm disabled:opacity-50"
          >
            {busy ? '...' : t('sidepanel.delegatePage.stop')}
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="px-4 py-2 rounded bg-green-600 text-white text-sm disabled:opacity-50"
          >
            {busy ? '...' : t('sidepanel.delegatePage.start')}
          </button>
        )}
      </section>

      <section className="text-sm">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${running ? 'bg-green-500' : 'bg-gray-400'}`}
          />
          <span>
            {running
              ? t('sidepanel.delegatePage.status.running')
              : t('sidepanel.delegatePage.status.stopped')}
          </span>
          {status?.runId !== undefined && (
            <span className="opacity-60 text-xs font-mono">{status.runId}</span>
          )}
        </div>
        {status?.tasksCompleted !== undefined && status.tasksCompleted > 0 && (
          <div className="opacity-70 mt-1">
            {t('sidepanel.delegatePage.tasksCompleted', { count: status.tasksCompleted })}
          </div>
        )}
        {status?.lastError !== undefined && (
          <div className="text-red-500 mt-1 text-xs">{status.lastError}</div>
        )}
        {error !== null && (
          <div className="text-red-500 mt-1 text-xs">{error}</div>
        )}
      </section>
    </div>
  );
}
