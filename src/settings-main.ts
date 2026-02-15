import './styles/main.css';
import './styles/settings-window.css';
import { RuntimeConfigPanel } from '@/components/RuntimeConfigPanel';
import { loadDesktopSecrets } from '@/services/runtime-config';
import { tryInvokeTauri } from '@/services/tauri-bridge';
import { escapeHtml } from '@/utils/sanitize';

let diagnosticsInitialized = false;

function setActionStatus(message: string, tone: 'ok' | 'error' = 'ok'): void {
  const statusEl = document.getElementById('settingsActionStatus');
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.classList.remove('ok', 'error');
  statusEl.classList.add(tone);
}

async function invokeDesktopAction(command: string, successLabel: string): Promise<void> {
  const result = await tryInvokeTauri<string>(command);
  if (result) {
    setActionStatus(`${successLabel}: ${result}`, 'ok');
    return;
  }

  setActionStatus(`Falha ao executar ${command}. Verifique o log do desktop.`, 'error');
}

function initTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.settings-tab');
  const panels = document.querySelectorAll<HTMLElement>('.settings-tab-panel');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      if (!target) return;

      tabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      panels.forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');

      const panelId = tab.getAttribute('aria-controls');
      if (panelId) {
        document.getElementById(panelId)?.classList.add('active');
      }

      if (target === 'debug' && !diagnosticsInitialized) {
        diagnosticsInitialized = true;
        initDiagnostics();
      }
    });
  });
}

function closeSettingsWindow(): void {
  void tryInvokeTauri<void>('close_settings_window').then(() => {}, () => window.close());
}

async function initSettingsWindow(): Promise<void> {
  await loadDesktopSecrets();

  const mount = document.getElementById('settingsApp');
  if (!mount) return;

  const panel = new RuntimeConfigPanel({ mode: 'full', buffered: true });
  const panelElement = panel.getElement();
  panelElement.classList.remove('resized', 'span-2', 'span-3', 'span-4');
  panelElement.classList.add('settings-runtime-panel');
  mount.appendChild(panelElement);

  window.addEventListener('beforeunload', () => panel.destroy());

  document.getElementById('okBtn')?.addEventListener('click', () => {
    void (async () => {
      try {
        if (!panel.hasPendingChanges()) {
          closeSettingsWindow();
          return;
        }
        setActionStatus('Validando chaves de API...', 'ok');
        const errors = await panel.verifyPendingSecrets();
        console.log('[settings] verify done, errors:', errors.length, errors);
        await panel.commitVerifiedSecrets();
        console.log('[settings] commit done, remaining pending:', panel.hasPendingChanges());
        if (errors.length > 0) {
          setActionStatus(`Chaves verificadas salvas. Falhas: ${errors.join(', ')}`, 'error');
        } else {
          setActionStatus('Configurações salvas', 'ok');
          closeSettingsWindow();
        }
      } catch (err) {
        console.error('[settings] save error:', err);
        setActionStatus(`Falha ao salvar: ${err}`, 'error');
      }
    })();
  });

  // Cancel: discard pending, close
  document.getElementById('cancelBtn')?.addEventListener('click', () => {
    closeSettingsWindow();
  });

  const openLogsBtn = document.getElementById('openLogsBtn');
  openLogsBtn?.addEventListener('click', () => {
    void invokeDesktopAction('open_logs_folder', 'Pasta de logs aberta');
  });

  const openSidecarLogBtn = document.getElementById('openSidecarLogBtn');
  openSidecarLogBtn?.addEventListener('click', () => {
    void invokeDesktopAction('open_sidecar_log_file', 'Log da API aberto');
  });

  initTabs();
}

const SIDECAR_BASE = 'http://127.0.0.1:46123';

function initDiagnostics(): void {
  const verboseToggle = document.getElementById('verboseApiLog') as HTMLInputElement | null;
  const fetchDebugToggle = document.getElementById('fetchDebugLog') as HTMLInputElement | null;
  const autoRefreshToggle = document.getElementById('autoRefreshLog') as HTMLInputElement | null;
  const refreshBtn = document.getElementById('refreshLogBtn');
  const clearBtn = document.getElementById('clearLogBtn');
  const trafficLogEl = document.getElementById('trafficLog');
  const trafficCount = document.getElementById('trafficCount');

  if (fetchDebugToggle) {
    fetchDebugToggle.checked = localStorage.getItem('wm-debug-log') === '1';
    fetchDebugToggle.addEventListener('change', () => {
      localStorage.setItem('wm-debug-log', fetchDebugToggle.checked ? '1' : '0');
    });
  }

  async function syncVerboseState(): Promise<void> {
    if (!verboseToggle) return;
    try {
      const res = await fetch(`${SIDECAR_BASE}/api/local-debug-toggle`);
      const data = await res.json();
      verboseToggle.checked = data.verboseMode;
    } catch { /* sidecar not running */ }
  }

  verboseToggle?.addEventListener('change', async () => {
    try {
      const res = await fetch(`${SIDECAR_BASE}/api/local-debug-toggle`, { method: 'POST' });
      const data = await res.json();
      if (verboseToggle) verboseToggle.checked = data.verboseMode;
      setActionStatus(data.verboseMode ? 'Log detalhado do sidecar ATIVADO (salvo)' : 'Log detalhado do sidecar DESATIVADO (salvo)', 'ok');
    } catch {
      setActionStatus('Não foi possível acessar o sidecar para alternar o modo detalhado', 'error');
    }
  });

  void syncVerboseState();

  async function refreshTrafficLog(): Promise<void> {
    if (!trafficLogEl) return;
    try {
      const res = await fetch(`${SIDECAR_BASE}/api/local-traffic-log`);
      const data = await res.json();
      const entries: Array<{ timestamp: string; method: string; path: string; status: number; durationMs: number }> = data.entries || [];
      if (trafficCount) trafficCount.textContent = `(${entries.length})`;

      if (entries.length === 0) {
        trafficLogEl.innerHTML = '<p class="diag-empty">Nenhum tráfego registrado ainda.</p>';
        return;
      }

      const rows = entries.slice().reverse().map((e) => {
        const ts = e.timestamp.split('T')[1]?.replace('Z', '') || e.timestamp;
        const cls = e.status < 300 ? 'ok' : e.status < 500 ? 'warn' : 'err';
        return `<tr class="diag-${cls}"><td>${escapeHtml(ts)}</td><td>${e.method}</td><td title="${escapeHtml(e.path)}">${escapeHtml(e.path)}</td><td>${e.status}</td><td>${e.durationMs}ms</td></tr>`;
      }).join('');

      trafficLogEl.innerHTML = `<table class="diag-table"><thead><tr><th>Hora</th><th>Método</th><th>Caminho</th><th>Status</th><th>Duração</th></tr></thead><tbody>${rows}</tbody></table>`;
    } catch {
      trafficLogEl.innerHTML = '<p class="diag-empty">Sidecar indisponível.</p>';
    }
  }

  refreshBtn?.addEventListener('click', () => void refreshTrafficLog());

  clearBtn?.addEventListener('click', async () => {
    try {
      await fetch(`${SIDECAR_BASE}/api/local-traffic-log`, { method: 'DELETE' });
    } catch { /* ignore */ }
    if (trafficLogEl) trafficLogEl.innerHTML = '<p class="diag-empty">Log limpo.</p>';
    if (trafficCount) trafficCount.textContent = '(0)';
  });

  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  function startAutoRefresh(): void {
    stopAutoRefresh();
    refreshInterval = setInterval(() => void refreshTrafficLog(), 3000);
  }

  function stopAutoRefresh(): void {
    if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
  }

  autoRefreshToggle?.addEventListener('change', () => {
    if (autoRefreshToggle.checked) startAutoRefresh(); else stopAutoRefresh();
  });

  void refreshTrafficLog();
  startAutoRefresh();
}

void initSettingsWindow().finally(() => {
  void tryInvokeTauri<void>('plugin:window|show', { label: 'settings' });
  void tryInvokeTauri<void>('plugin:window|set_focus', { label: 'settings' });
});
