import { fetchSystemHealth, type HealthStatus, type HealthCheck } from '@/services/health';
import { h, replaceChildren } from '@/utils/dom-utils';
import './GlobalHealthDashboard.css';

export class GlobalHealthDashboard {
  private element: HTMLElement;
  private container: HTMLElement;
  private status: HealthStatus | null = null;
  private loading = false;
  private visible = false;

  constructor() {
    this.element = h('div', { className: 'global-health-dashboard hidden' },
      h('div', { className: 'dashboard-overlay', onClick: () => this.hide() }),
      h('div', { className: 'dashboard-content' },
        h('div', { className: 'dashboard-header' },
          h('div', { className: 'header-left' },
            h('h1', null, 'System Health Monitor'),
            h('div', { className: 'last-checked' }, 'Last checked: --'),
          ),
          h('button', { className: 'close-btn', onClick: () => this.hide() }, '×'),
        ),
        this.container = h('div', { className: 'dashboard-body' }),
      ),
    );
    document.body.appendChild(this.element);
  }

  public async show(): Promise<void> {
    this.visible = true;
    this.element.classList.remove('hidden');
    document.body.classList.add('dashboard-open');
    await this.refresh();
  }

  public hide(): void {
    this.visible = false;
    this.element.classList.add('hidden');
    document.body.classList.remove('dashboard-open');
  }

  public isVisible(): boolean {
    return this.visible;
  }

  private async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.renderLoading();

    try {
      this.status = await fetchSystemHealth();
      this.render();
    } catch (err) {
      this.renderError();
    } finally {
      this.loading = false;
    }
  }

  private renderLoading(): void {
    replaceChildren(this.container,
      h('div', { className: 'dashboard-loading' },
        h('div', { className: 'loading-spinner' }),
        h('span', null, 'Syncing system status...'),
      ),
    );
  }

  private renderError(): void {
    replaceChildren(this.container,
      h('div', { className: 'dashboard-error' },
        h('p', null, 'Failed to fetch system data.'),
        h('button', { onClick: () => this.refresh() }, 'Retry'),
      ),
    );
  }

  private render(): void {
    if (!this.status || !this.status.summary) return;

    const { status, summary, checkedAt, checks } = this.status;

    // Update header time
    const timeEl = this.element.querySelector('.last-checked');
    if (timeEl) timeEl.textContent = `Last checked: ${new Date(checkedAt).toLocaleTimeString()}`;

    // Categorize checks
    const categories: Record<string, Record<string, HealthCheck>> = {
      'Intelligence': {},
      'Maritime & Aviation': {},
      'Market & Finance': {},
      'Environmental': {},
      'Infrastructure': {},
      'Geopolitical': {},
      'Economic': {},
      'Other': {},
    };

    if (checks) {
      for (const [name, check] of Object.entries(checks)) {
        const cat = this.resolveCategory(name);
        (categories[cat] || (categories[cat] = {}))[name] = check;
      }
    }

    replaceChildren(this.container,
      this.renderHero(status, summary),
      h('div', { className: 'dashboard-grid' },
        ...Object.entries(categories)
          .filter(([_, items]) => Object.keys(items).length > 0)
          .map(([cat, items]) => this.renderCategory(cat, items)),
      ),
    );
  }

  private renderHero(status: string, summary: any): HTMLElement {
    const statusMeta = {
      HEALTHY: { label: 'ALL SYSTEMS OPERATIONAL', color: 'var(--success)' },
      DEGRADED: { label: 'SYSTEM DEGRADED', color: 'var(--warning)' },
      UNHEALTHY: { label: 'CRITICAL DISRUPTION', color: 'var(--error)' },
      REDIS_DOWN: { label: 'INFRASTRUCTURE FAILURE', color: 'var(--error)' },
    }[status] || { label: status, color: 'var(--text-dim)' };

    return h('div', { className: `dashboard-hero ${status.toLowerCase()}` },
      h('div', { className: 'hero-status' },
        h('div', { className: 'status-indicator', style: { backgroundColor: statusMeta.color } }),
        h('div', { className: 'status-label' }, statusMeta.label),
      ),
      h('div', { className: 'hero-stats' },
        h('div', { className: 'stat-card' },
          h('div', { className: 'stat-value' }, String(summary.ok)),
          h('div', { className: 'stat-label' }, 'Operational'),
        ),
        h('div', { className: 'stat-card' },
          h('div', { className: 'stat-value warning' }, String(summary.warn)),
          h('div', { className: 'stat-label' }, 'Stale / Warm'),
        ),
        h('div', { className: 'stat-card' },
          h('div', { className: 'stat-value error' }, String(summary.crit)),
          h('div', { className: 'stat-label' }, 'Empty / Offline'),
        ),
      ),
    );
  }

  private renderCategory(name: string, items: Record<string, HealthCheck>): HTMLElement {
    return h('div', { className: 'dashboard-category' },
      h('h2', null, name),
      h('div', { className: 'category-items' },
        ...Object.entries(items).map(([id, check]) => this.renderCheckItem(id, check)),
      ),
    );
  }

  private renderCheckItem(id: string, check: HealthCheck): HTMLElement {
    const statusClass = {
      OK: 'ok',
      OK_CASCADE: 'ok',
      STALE_SEED: 'warning',
      EMPTY_ON_DEMAND: 'warning',
      EMPTY: 'error',
      EMPTY_DATA: 'error',
    }[check.status] || 'unknown';

    const normalizedName = id
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .replace(/Live$/, ' (Live)')
      .replace(/Stale$/, ' (Archive)');

    return h('div', { className: `check-card ${statusClass}` },
      h('div', { className: 'check-main' },
        h('div', { className: 'check-name' }, normalizedName),
        h('div', { className: 'check-records' }, `${check.records} records`),
      ),
      h('div', { className: 'check-footer' },
        h('div', { className: 'check-status' }, check.status.replace(/_/g, ' ')),
        check.seedAgeMin !== undefined && h('div', { className: 'check-age' }, `${check.seedAgeMin}m old`),
      ),
    );
  }

  private resolveCategory(name: string): string {
    const n = name.toLowerCase();
    if (n.includes('satellite') || n.includes('cyber') || n.includes('gps') || n.includes('intelligence')) return 'Intelligence';
    if (n.includes('flight') || n.includes('aviation') || n.includes('shipping') || n.includes('chokepoint') || n.includes('notam')) return 'Maritime & Aviation';
    if (n.includes('market') || n.includes('etf') || n.includes('crypto') || n.includes('stablecoin') || n.includes('commodity') || n.includes('sector')) return 'Market & Finance';
    if (n.includes('earthquake') || n.includes('wildfire') || n.includes('climate') || n.includes('weather') || n.includes('natural')) return 'Environmental';
    if (n.includes('service') || n.includes('outage') || n.includes('infra') || n.includes('cable') || n.includes('posture')) return 'Infrastructure';
    if (n.includes('unrest') || n.includes('iran') || n.includes('ucdp') || n.includes('risk') || n.includes('conflict')) return 'Geopolitical';
    if (n.includes('macro') || n.includes('spending') || n.includes('bis') || n.includes('giving') || n.includes('economic') || n.includes('progress') || n.includes('minerals')) return 'Economic';
    return 'Other';
  }
}
