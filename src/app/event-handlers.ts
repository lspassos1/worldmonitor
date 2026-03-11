import type { AppContext, AppModule } from '@/app/app-context';
import type { PanelConfig, MapLayers } from '@/types';
import type { MapView } from '@/components';
import {
  PlaybackControl,
  StatusPanel,
  PizzIntIndicator,
  CIIPanel,
} from '@/components';
import { h } from '@/utils/dom-utils';
import {
  buildMapUrl,
  debounce,
  saveToStorage,
  ExportPanel,
  getCurrentTheme,
  setTheme,
} from '@/utils';
import {
  IDLE_PAUSE_MS,
  STORAGE_KEYS,
  SITE_VARIANT,
  FEEDS,
  INTEL_SOURCES,
  DEFAULT_PANELS,
} from '@/config';
import { VARIANT_META } from '@/config/variant-meta';
import {
} from '@/services';
import {
  trackVariantSwitch,
  trackThemeChanged,
  trackMapViewChange,
  trackPanelToggled,
  trackDownloadClicked,
} from '@/services/analytics';
import { detectPlatform, allButtons, buttonsForPlatform } from '@/components/DownloadBanner';
import type { Platform } from '@/components/DownloadBanner';
import { invokeTauri } from '@/services/tauri-bridge';
import { fetchSystemHealth } from '@/services/health';
import { mlWorker } from '@/services/ml-worker';
import { UnifiedSettings } from '@/components/UnifiedSettings';
import { t } from '@/services/i18n';
import { TvModeController } from '@/services/tv-mode';

export interface EventHandlerCallbacks {
  updateSearchIndex: () => void;
  loadAllData: () => Promise<void>;
  flushStaleRefreshes: () => void;
  setHiddenSince: (ts: number) => void;
  loadDataForLayer: (layer: string) => void;
  waitForAisData: () => void;
  syncDataFreshnessWithLayers: () => void;
  ensureCorrectZones: () => void;
  refreshOpenCountryBrief?: () => void;
  stopLayerActivity?: (layer: keyof MapLayers) => void;
}

export class EventHandlerManager implements AppModule {
  private ctx: AppContext;
  private callbacks: EventHandlerCallbacks;

  private boundFullscreenHandler: (() => void) | null = null;
  private boundResizeHandler: (() => void) | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private boundDesktopExternalLinkHandler: ((e: MouseEvent) => void) | null = null;
  private boundIdleResetHandler: (() => void) | null = null;
  private boundStorageHandler: ((e: StorageEvent) => void) | null = null;
  private boundTvKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundFocalPointsReadyHandler: (() => void) | null = null;
  private boundThemeChangedHandler: (() => void) | null = null;
  private boundDropdownClickHandler: ((e: MouseEvent) => void) | null = null;
  private boundDropdownKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundMapResizeMoveHandler: ((e: MouseEvent) => void) | null = null;
  private boundMapEndResizeHandler: (() => void) | null = null;
  private boundMapResizeVisChangeHandler: (() => void) | null = null;
  private boundMapFullscreenEscHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundMobileMenuKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private snapshotIntervalId: ReturnType<typeof setInterval> | null = null;
  private clockIntervalId: ReturnType<typeof setInterval> | null = null;

  private readonly idlePauseMs = IDLE_PAUSE_MS;
  private readonly debouncedUrlSync = debounce(() => {
    const shareUrl = this.getShareUrl();
    if (!shareUrl) return;
    try { history.replaceState(null, '', shareUrl); } catch { }
  }, 250);

  constructor(ctx: AppContext, callbacks: EventHandlerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  init(): void {
    this.setupEventListeners();
    this.setupIdleDetection();
    this.setupTvMode();
  }

  private setupTvMode(): void {
    if (SITE_VARIANT !== 'happy') return;

    const tvBtn = document.getElementById('tvModeBtn');
    const tvExitBtn = document.getElementById('tvExitBtn');
    if (tvBtn) {
      tvBtn.addEventListener('click', () => this.toggleTvMode());
    }
    if (tvExitBtn) {
      tvExitBtn.addEventListener('click', () => this.toggleTvMode());
    }
    // Keyboard shortcut: Shift+T
    this.boundTvKeydownHandler = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'T' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const active = document.activeElement;
        if (active?.tagName !== 'INPUT' && active?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          this.toggleTvMode();
        }
      }
    };
    document.addEventListener('keydown', this.boundTvKeydownHandler);
  }

  private toggleTvMode(): void {
    const panelKeys = Object.keys(DEFAULT_PANELS).filter(
      key => this.ctx.panelSettings[key]?.enabled !== false
    );
    if (!this.ctx.tvMode) {
      this.ctx.tvMode = new TvModeController({
        panelKeys,
        onPanelChange: () => {
          document.getElementById('tvModeBtn')?.classList.toggle('active', this.ctx.tvMode?.active ?? false);
        }
      });
    } else {
      this.ctx.tvMode.updatePanelKeys(panelKeys);
    }
    this.ctx.tvMode.toggle();
    document.getElementById('tvModeBtn')?.classList.toggle('active', this.ctx.tvMode.active);
  }

  destroy(): void {
    this.debouncedUrlSync.cancel();
    if (this.boundFullscreenHandler) {
      document.removeEventListener('fullscreenchange', this.boundFullscreenHandler);
      this.boundFullscreenHandler = null;
    }
    if (this.boundResizeHandler) {
      window.removeEventListener('resize', this.boundResizeHandler);
      this.boundResizeHandler = null;
    }
    if (this.boundVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.boundDesktopExternalLinkHandler) {
      document.removeEventListener('click', this.boundDesktopExternalLinkHandler, true);
      this.boundDesktopExternalLinkHandler = null;
    }
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    if (this.boundIdleResetHandler) {
      ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
        document.removeEventListener(event, this.boundIdleResetHandler!);
      });
      this.boundIdleResetHandler = null;
    }
    if (this.snapshotIntervalId) {
      clearInterval(this.snapshotIntervalId);
      this.snapshotIntervalId = null;
    }
    if (this.clockIntervalId) {
      clearInterval(this.clockIntervalId);
      this.clockIntervalId = null;
    }
    if (this.boundStorageHandler) {
      window.removeEventListener('storage', this.boundStorageHandler);
      this.boundStorageHandler = null;
    }
    if (this.boundTvKeydownHandler) {
      document.removeEventListener('keydown', this.boundTvKeydownHandler);
      this.boundTvKeydownHandler = null;
    }
    if (this.boundFocalPointsReadyHandler) {
      window.removeEventListener('focal-points-ready', this.boundFocalPointsReadyHandler);
      this.boundFocalPointsReadyHandler = null;
    }
    if (this.boundThemeChangedHandler) {
      window.removeEventListener('theme-changed', this.boundThemeChangedHandler);
      this.boundThemeChangedHandler = null;
    }
    if (this.boundDropdownClickHandler) {
      document.removeEventListener('click', this.boundDropdownClickHandler);
      this.boundDropdownClickHandler = null;
    }
    if (this.boundDropdownKeydownHandler) {
      document.removeEventListener('keydown', this.boundDropdownKeydownHandler);
      this.boundDropdownKeydownHandler = null;
    }
    if (this.boundMapResizeMoveHandler) {
      document.removeEventListener('mousemove', this.boundMapResizeMoveHandler);
      this.boundMapResizeMoveHandler = null;
    }
    if (this.boundMapEndResizeHandler) {
      document.removeEventListener('mouseup', this.boundMapEndResizeHandler);
      window.removeEventListener('blur', this.boundMapEndResizeHandler);
      this.boundMapEndResizeHandler = null;
    }
    if (this.boundMapResizeVisChangeHandler) {
      document.removeEventListener('visibilitychange', this.boundMapResizeVisChangeHandler);
      this.boundMapResizeVisChangeHandler = null;
    }
    if (this.boundMapFullscreenEscHandler) {
      document.removeEventListener('keydown', this.boundMapFullscreenEscHandler);
      this.boundMapFullscreenEscHandler = null;
    }
    if (this.boundMobileMenuKeyHandler) {
      document.removeEventListener('keydown', this.boundMobileMenuKeyHandler);
      this.boundMobileMenuKeyHandler = null;
    }
    this.ctx.tvMode?.destroy();
    this.ctx.tvMode = null;
    this.ctx.unifiedSettings?.destroy();
    this.ctx.unifiedSettings = null;
  }

  private setupEventListeners(): void {
    const openSearch = () => {
      this.callbacks.updateSearchIndex();
      this.ctx.searchModal?.open();
    };
    document.getElementById('searchBtn')?.addEventListener('click', openSearch);
    document.getElementById('mobileSearchBtn')?.addEventListener('click', openSearch);
    document.getElementById('searchMobileFab')?.addEventListener('click', openSearch);

    document.getElementById('copyLinkBtn')?.addEventListener('click', async () => {
      const shareUrl = this.getShareUrl();
      if (!shareUrl) return;
      const button = document.getElementById('copyLinkBtn');
      try {
        await this.copyToClipboard(shareUrl);
        this.setCopyLinkFeedback(button, 'Copied!');
      } catch (error) {
        console.warn('Failed to copy share link:', error);
        this.setCopyLinkFeedback(button, 'Copy failed');
      }
    });

    this.initDownloadDropdown();

    this.boundStorageHandler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.panels && e.newValue) {
        try {
          this.ctx.panelSettings = JSON.parse(e.newValue) as Record<string, PanelConfig>;
          this.applyPanelSettings();
          this.ctx.unifiedSettings?.refreshPanelToggles();
        } catch (_) { }
      }
      if (e.key === STORAGE_KEYS.liveChannels && e.newValue) {
        const panel = this.ctx.panels['live-news'];
        if (panel && typeof (panel as unknown as { refreshChannelsFromStorage?: () => void }).refreshChannelsFromStorage === 'function') {
          (panel as unknown as { refreshChannelsFromStorage: () => void }).refreshChannelsFromStorage();
        }
      }
    };
    window.addEventListener('storage', this.boundStorageHandler);

    document.getElementById('headerThemeToggle')?.addEventListener('click', () => {
      const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
      this.updateHeaderThemeIcon();
      trackThemeChanged(next);
    });

    const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    this.ctx.container.querySelectorAll<HTMLAnchorElement>('.variant-option').forEach(link => {
      link.addEventListener('click', (e) => {
        const variant = link.dataset.variant;
        if (!variant || variant === SITE_VARIANT) return;
        e.preventDefault();
        void this.navigateToVariant(variant, {
          href: link.href,
          isLocalDev,
        });
      });
    });

    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (!this.ctx.isDesktopApp && fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
      this.boundFullscreenHandler = () => {
        fullscreenBtn.textContent = document.fullscreenElement ? '\u26F6' : '\u26F6';
        fullscreenBtn.classList.toggle('active', !!document.fullscreenElement);
      };
      document.addEventListener('fullscreenchange', this.boundFullscreenHandler);
    }

    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    regionSelect?.addEventListener('change', () => {
      this.ctx.map?.setView(regionSelect.value as MapView);
      trackMapViewChange(regionSelect.value);
    });

    this.boundResizeHandler = debounce(() => {
      this.ctx.map?.setIsResizing(false);
      this.ctx.map?.render();
    }, 150);
    window.addEventListener('resize', this.boundResizeHandler);

    this.setupMapResize();
    this.setupMapPin();

    this.boundVisibilityHandler = () => {
      document.body?.classList.toggle('animations-paused', document.hidden);
      if (this.ctx.isDesktopApp) {
        this.ctx.map?.setRenderPaused(document.hidden);
      }
      if (document.hidden) {
        this.callbacks.setHiddenSince(Date.now());
        mlWorker.unloadOptionalModels();
      } else {
        this.resetIdleTimer();
        this.callbacks.flushStaleRefreshes();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    this.boundFocalPointsReadyHandler = () => {
      (this.ctx.panels['cii'] as CIIPanel)?.refresh(true);
      this.callbacks.refreshOpenCountryBrief?.();
    };
    window.addEventListener('focal-points-ready', this.boundFocalPointsReadyHandler);

    this.boundThemeChangedHandler = () => {
      this.ctx.map?.render();
      this.updateHeaderThemeIcon();
      this.updateMobileMenuThemeItem();
    };
    window.addEventListener('theme-changed', this.boundThemeChangedHandler);

    this.setupMobileMenu();

    if (this.ctx.isDesktopApp) {
      if (this.boundDesktopExternalLinkHandler) {
        document.removeEventListener('click', this.boundDesktopExternalLinkHandler, true);
      }
      this.boundDesktopExternalLinkHandler = (e: MouseEvent) => {
        if (!(e.target instanceof Element)) return;
        const anchor = e.target.closest('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        const href = anchor.href;
        if (!href || href.startsWith('javascript:') || href === '#' || href.startsWith('#')) return;
        // Only handle valid http(s) URLs
        let url: URL;
        try {
          url = new URL(href, window.location.href);
        } catch {
          // Malformed URL, let browser handle
          return;
        }
        if (url.origin === window.location.origin) return;
        if (!/^https?:$/.test(url.protocol)) return; // Only allow http(s) links
        e.preventDefault();
        e.stopPropagation();
        void invokeTauri<void>('open_url', { url: url.toString() }).catch(() => {
          window.open(url.toString(), '_blank');
        });
      };
      document.addEventListener('click', this.boundDesktopExternalLinkHandler, true);
    }
  }

  private setupMobileMenu(): void {
    const hamburger = document.getElementById('hamburgerBtn');
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    const closeBtn = document.getElementById('mobileMenuClose');
    if (!hamburger || !overlay || !menu || !closeBtn) return;

    hamburger.addEventListener('click', () => this.openMobileMenu());
    overlay.addEventListener('click', () => this.closeMobileMenu());
    closeBtn.addEventListener('click', () => this.closeMobileMenu());

    const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    menu.querySelectorAll<HTMLButtonElement>('.mobile-menu-variant').forEach(btn => {
      btn.addEventListener('click', () => {
        const variant = btn.dataset.variant;
        if (!variant || variant === SITE_VARIANT) return;
        void this.navigateToVariant(variant, { isLocalDev });
      });
    });

    document.getElementById('mobileMenuRegion')?.addEventListener('click', () => {
      this.closeMobileMenu();
      this.openRegionSheet();
    });

    document.getElementById('mobileMenuSettings')?.addEventListener('click', () => {
      this.closeMobileMenu();
      this.ctx.unifiedSettings?.open();
    });

    document.getElementById('mobileMenuTheme')?.addEventListener('click', () => {
      this.closeMobileMenu();
      const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
      this.updateHeaderThemeIcon();
      trackThemeChanged(next);
    });

    const sheetBackdrop = document.getElementById('regionSheetBackdrop');
    sheetBackdrop?.addEventListener('click', () => this.closeRegionSheet());

    const sheet = document.getElementById('regionBottomSheet');
    sheet?.querySelectorAll<HTMLButtonElement>('.region-sheet-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const region = opt.dataset.region;
        if (!region) return;
        this.ctx.map?.setView(region as MapView);
        trackMapViewChange(region);
        const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
        if (regionSelect) regionSelect.value = region;
        sheet.querySelectorAll('.region-sheet-option').forEach(o => {
          o.classList.toggle('active', o === opt);
          const check = o.querySelector('.region-sheet-check');
          if (check) check.textContent = o === opt ? '✓' : '';
        });
        const menuRegionLabel = document.getElementById('mobileMenuRegion')?.querySelector('.mobile-menu-item-label');
        if (menuRegionLabel) menuRegionLabel.textContent = opt.querySelector('span')?.textContent ?? '';
        this.closeRegionSheet();
      });
    });

    this.boundMobileMenuKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (sheet?.classList.contains('open')) {
          this.closeRegionSheet();
        } else if (menu.classList.contains('open')) {
          this.closeMobileMenu();
        }
      }
    };
    document.addEventListener('keydown', this.boundMobileMenuKeyHandler);
  }

  private openMobileMenu(): void {
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    if (!overlay || !menu) return;
    overlay.classList.add('open');
    requestAnimationFrame(() => menu.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }

  private closeMobileMenu(): void {
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    if (!overlay || !menu) return;
    menu.classList.remove('open');
    overlay.classList.remove('open');
    const sheetOpen = document.getElementById('regionBottomSheet')?.classList.contains('open');
    if (!sheetOpen) document.body.style.overflow = '';
  }

  private openRegionSheet(): void {
    const backdrop = document.getElementById('regionSheetBackdrop');
    const sheet = document.getElementById('regionBottomSheet');
    if (!backdrop || !sheet) return;
    backdrop.classList.add('open');
    requestAnimationFrame(() => sheet.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }

  private closeRegionSheet(): void {
    const backdrop = document.getElementById('regionSheetBackdrop');
    const sheet = document.getElementById('regionBottomSheet');
    if (!backdrop || !sheet) return;
    sheet.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.style.overflow = '';
  }

  private setupIdleDetection(): void {
    this.boundIdleResetHandler = () => {
      if (this.ctx.isIdle) {
        this.ctx.isIdle = false;
        document.body?.classList.remove('animations-paused');
      }
      this.resetIdleTimer();
    };

    ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
      document.addEventListener(event, this.boundIdleResetHandler!, { passive: true });
    });

    this.resetIdleTimer();
  }

  resetIdleTimer(): void {
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
    }
    this.idleTimeoutId = setTimeout(() => {
      if (!document.hidden) {
        this.ctx.isIdle = true;
        document.body?.classList.add('animations-paused');
        console.log('[App] User idle - pausing animations to save resources');
      }
    }, this.idlePauseMs);
  }

  setupUrlStateSync(): void {
    if (!this.ctx.map) return;

    this.ctx.map.onStateChanged(() => {
      this.debouncedUrlSync();
      const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
      if (regionSelect && this.ctx.map) {
        const state = this.ctx.map.getState();
        if (regionSelect.value !== state.view) {
          regionSelect.value = state.view;
        }
      }
    });
    this.debouncedUrlSync();
  }

  syncUrlState(): void {
    this.debouncedUrlSync();
  }

  getShareUrl(): string | null {
    if (!this.ctx.map) return null;
    const state = this.ctx.map.getState();
    const center = this.ctx.map.getCenter();
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const briefPage = this.ctx.countryBriefPage;
    const isCountryVisible = briefPage?.isVisible() ?? false;
    return buildMapUrl(baseUrl, {
      view: state.view,
      zoom: state.zoom,
      center,
      timeRange: state.timeRange,
      layers: state.layers,
      country: isCountryVisible ? (briefPage?.getCode() ?? undefined) : undefined,
      expanded: isCountryVisible && briefPage?.getIsMaximized?.() ? true : undefined,
    });
  }

  private async copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  private platformLabel(p: Platform): string {
    switch (p) {
      case 'macos-arm64': return '\uF8FF Silicon';
      case 'macos-x64': return '\uF8FF Intel';
      case 'macos': return '\uF8FF macOS';
      case 'windows': return 'Windows';
      case 'linux': return 'Linux';
      default: return t('header.downloadApp');
    }
  }

  private initDownloadDropdown(): void {
    const btn = document.getElementById('downloadBtn');
    const dropdown = document.getElementById('downloadDropdown');
    const label = document.getElementById('downloadBtnLabel');
    if (!btn || !dropdown) return;

    const platform = detectPlatform();
    if (label) label.textContent = this.platformLabel(platform);

    const primary = buttonsForPlatform(platform);
    const all = allButtons();
    const others = all.filter(b => !primary.some(p => p.href === b.href));

    const renderDropdown = () => {
      const primaryHtml = primary.map(b =>
        `<a class="dl-dd-btn ${b.cls} primary" href="${b.href}">${b.label}</a>`
      ).join('');
      const othersHtml = others.map(b =>
        `<a class="dl-dd-btn ${b.cls}" href="${b.href}">${b.label}</a>`
      ).join('');

      dropdown.innerHTML = `
        <div class="dl-dd-tagline">${t('modals.downloadBanner.description')}</div>
        <div class="dl-dd-buttons">${primaryHtml}</div>
        ${others.length ? `<button class="dl-dd-toggle" id="dlDdToggle">${t('modals.downloadBanner.showAllPlatforms')}</button>
        <div class="dl-dd-others" id="dlDdOthers">${othersHtml}</div>` : ''}
      `;

      dropdown.querySelectorAll<HTMLAnchorElement>('.dl-dd-btn').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const plat = new URL(a.href, location.origin).searchParams.get('platform') || 'unknown';
          trackDownloadClicked(plat);
          window.open(a.href, '_blank');
          dropdown.classList.remove('open');
        });
      });

      const toggle = dropdown.querySelector('#dlDdToggle');
      const othersEl = dropdown.querySelector('#dlDdOthers') as HTMLElement | null;
      if (toggle && othersEl) {
        toggle.addEventListener('click', () => {
          const showing = othersEl.classList.toggle('show');
          toggle.textContent = showing
            ? t('modals.downloadBanner.showLess')
            : t('modals.downloadBanner.showAllPlatforms');
        });
      }
    };

    renderDropdown();

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    this.boundDropdownClickHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !btn.contains(e.target as Node)) {
        dropdown.classList.remove('open');
      }
    };
    document.addEventListener('click', this.boundDropdownClickHandler);

    this.boundDropdownKeydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dropdown.classList.remove('open');
    };
    document.addEventListener('keydown', this.boundDropdownKeydownHandler);
  }

  private setCopyLinkFeedback(button: HTMLElement | null, message: string): void {
    if (!button) return;
    const originalText = button.textContent ?? '';
    button.textContent = message;
    button.classList.add('copied');
    window.setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 1500);
  }

  private getFullscreenDocument(): Document & {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | void;
  } {
    return document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
  }

  private async exitFullscreenForNavigation(): Promise<void> {
    const fullscreenDocument = this.getFullscreenDocument();
    if (!fullscreenDocument.fullscreenElement && !fullscreenDocument.webkitFullscreenElement) return;
    try {
      if (typeof fullscreenDocument.exitFullscreen === 'function') {
        await fullscreenDocument.exitFullscreen();
        return;
      }
      await fullscreenDocument.webkitExitFullscreen?.();
    } catch { /* proceed with navigation regardless */ }
  }

  private async navigateToVariant(
    variant: string,
    options: { href?: string; isLocalDev: boolean },
  ): Promise<void> {
    trackVariantSwitch(SITE_VARIANT, variant);
    await this.exitFullscreenForNavigation();

    if (this.ctx.isDesktopApp || options.isLocalDev) {
      localStorage.setItem('worldmonitor-variant', variant);
      window.location.reload();
      return;
    }

    const target = options.href || VARIANT_META[variant]?.url;
    if (target) window.location.href = target;
  }

  toggleFullscreen(): void {
    const fullscreenDocument = this.getFullscreenDocument();
    if (fullscreenDocument.fullscreenElement || fullscreenDocument.webkitFullscreenElement) {
      try {
        const exitResult = typeof fullscreenDocument.exitFullscreen === 'function'
          ? fullscreenDocument.exitFullscreen()
          : fullscreenDocument.webkitExitFullscreen?.();
        void Promise.resolve(exitResult).catch(() => { });
      } catch { }
    } else {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (el.requestFullscreen) {
        try { void el.requestFullscreen()?.catch(() => { }); } catch { }
      } else if (el.webkitRequestFullscreen) {
        try { el.webkitRequestFullscreen(); } catch { }
      }
    }
  }

  updateHeaderThemeIcon(): void {
    const btn = document.getElementById('headerThemeToggle');
    if (!btn) return;
    const isDark = getCurrentTheme() === 'dark';
    btn.innerHTML = isDark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  }

  private updateMobileMenuThemeItem(): void {
    const btn = document.getElementById('mobileMenuTheme');
    if (!btn) return;
    const isDark = getCurrentTheme() === 'dark';
    const icon = btn.querySelector('.mobile-menu-item-icon');
    const label = btn.querySelector('.mobile-menu-item-label');
    if (icon) icon.textContent = isDark ? '☀️' : '🌙';
    if (label) label.textContent = isDark ? 'Light Mode' : 'Dark Mode';
  }

  startHeaderClock(): void {
    const el = document.getElementById('headerClock');
    if (!el) return;
    const tick = () => {
      el.textContent = new Date().toUTCString().replace('GMT', 'UTC');
    };
    tick();
    this.clockIntervalId = setInterval(tick, 1000);
  }

  setupStatusPanel(): void {
    this.ctx.statusPanel = new (StatusPanel as any)();
  }

  setupPizzIntIndicator(): void {
    if (SITE_VARIANT === 'tech' || SITE_VARIANT === 'finance' || SITE_VARIANT === 'happy') return;

    this.ctx.pizzintIndicator = new (PizzIntIndicator as any)();
    const headerLeft = this.ctx.container.querySelector('.header-left');
    if (headerLeft && this.ctx.pizzintIndicator) {
      headerLeft.appendChild((this.ctx.pizzintIndicator as any).getElement());
    }
  }

  setupExportPanel(): void {
    this.ctx.exportPanel = new ExportPanel(() => ({
      news: this.ctx.latestClusters.length > 0 ? this.ctx.latestClusters : this.ctx.allNews,
      markets: this.ctx.latestMarkets,
      predictions: this.ctx.latestPredictions,
      timestamp: Date.now(),
    }));

    const headerRight = this.ctx.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(this.ctx.exportPanel.getElement(), headerRight.firstChild);
    }
  }

  setupHealthIndicator(): void {
    const headerRight = this.ctx.container.querySelector('.header-right');
    if (!headerRight) return;

    const indicator = h('div', {
      id: 'globalHealthIndicator',
      className: 'header-tool health-indicator',
      title: 'System Health Status',
      onClick: () => this.ctx.globalHealthDashboard?.show(),
    }, h('div', { className: 'status-dot' }));

    headerRight.insertBefore(indicator, headerRight.firstChild);

    // Initial status sync
    this.updateHealthIndicator();
    // Refresh every minute
    setInterval(() => this.updateHealthIndicator(), 60000);
  }

  private async updateHealthIndicator(): Promise<void> {
    const el = document.getElementById('globalHealthIndicator');
    if (!el) return;

    try {
      const health = await fetchSystemHealth();
      const dot = el.querySelector('.status-dot') as HTMLElement;
      if (!dot || !health) return;

      el.className = `header-tool health-indicator ${health.status.toLowerCase()}`;
      dot.style.backgroundColor = ({
        HEALTHY: 'var(--success)',
        DEGRADED: 'var(--warning)',
        UNHEALTHY: 'var(--error)',
        REDIS_DOWN: 'var(--error)',
      } as any)[health.status] || 'var(--text-dim)';
    } catch {
      el.className = 'header-tool health-indicator unknown';
    }
  }

  setupUnifiedSettings(): void {
    this.ctx.unifiedSettings = new UnifiedSettings({
      getPanelSettings: () => this.ctx.panelSettings,
      savePanelSettings: (panels: Record<string, PanelConfig>) => {
        Object.entries(panels).forEach(([key, nextConfig]) => {
          const current = this.ctx.panelSettings[key];
          if (!current) {
            this.ctx.panelSettings[key] = { ...nextConfig };
            trackPanelToggled(key, nextConfig.enabled);
            return;
          }
          if (current.enabled !== nextConfig.enabled) {
            trackPanelToggled(key, nextConfig.enabled);
          }
          Object.assign(current, nextConfig);
        });
        saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
      },
      getDisabledSources: () => this.ctx.disabledSources,
      toggleSource: (name: string) => {
        if (this.ctx.disabledSources.has(name)) {
          this.ctx.disabledSources.delete(name);
        } else {
          this.ctx.disabledSources.add(name);
        }
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(this.ctx.disabledSources));
      },
      setSourcesEnabled: (names: string[], enabled: boolean) => {
        names.forEach(name => {
          if (enabled) {
            this.ctx.disabledSources.delete(name);
          } else {
            this.ctx.disabledSources.add(name);
          }
        });
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(this.ctx.disabledSources));
      },
      getAllSourceNames: () => {
        const names: string[] = [];
        Object.values(FEEDS).forEach(group => group.forEach(f => names.push(f.name)));
        INTEL_SOURCES.forEach(f => names.push(f.name));
        return Array.from(new Set(names)).sort();
      },
      getLocalizedPanelName: (key: string, fallback: string) => t(`panels.${key}.label`, { defaultValue: fallback }),
      resetLayout: () => this.callbacks.ensureCorrectZones(),
      isDesktopApp: this.ctx.isDesktopApp,
      alertManager: this.ctx.alertManager || undefined,
    });
  }

  setupPlaybackControl(): void {
    this.ctx.playbackControl = new (PlaybackControl as any)();
    const headerRight = this.ctx.container.querySelector('.header-right');
    if (headerRight && this.ctx.playbackControl) {
      headerRight.insertBefore((this.ctx.playbackControl as any).getElement(), headerRight.firstChild);
    }
  }

  private setupMapResize(): void {
    const resizeHandle = document.getElementById('mapResizeHandle');
    if (!resizeHandle) return;

    this.boundMapResizeMoveHandler = (e: MouseEvent) => {
      if (!this.ctx.map?.getIsResizing()) return;
      const height = window.innerHeight - e.clientY;
      const minHeight = 200;
      const maxHeight = window.innerHeight - 100;
      const clamped = Math.max(minHeight, Math.min(maxHeight, height));
      document.documentElement.style.setProperty('--map-height', `${clamped}px`);
      this.ctx.map?.render();
    };

    this.boundMapEndResizeHandler = () => {
      if (this.ctx.map?.getIsResizing()) {
        this.ctx.map?.setIsResizing(false);
        document.body.classList.remove('map-resizing');
        saveToStorage<any>('worldmonitor-map-height', getComputedStyle(document.documentElement).getPropertyValue('--map-height'));
      }
    };

    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.ctx.map?.setIsResizing(true);
      document.body.classList.add('map-resizing');
    });

    document.addEventListener('mousemove', this.boundMapResizeMoveHandler);
    document.addEventListener('mouseup', this.boundMapEndResizeHandler);
    window.addEventListener('blur', this.boundMapEndResizeHandler);

    this.boundMapResizeVisChangeHandler = () => {
      if (document.hidden) this.boundMapEndResizeHandler!();
    };
    document.addEventListener('visibilitychange', this.boundMapResizeVisChangeHandler);
  }

  private setupMapPin(): void {
    this.boundMapFullscreenEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.ctx.map?.getIsPinned()) {
        this.ctx.map?.setIsPinned(false);
      }
    };
    document.addEventListener('keydown', this.boundMapFullscreenEscHandler);
  }

  private applyPanelSettings(): void {
    Object.entries(this.ctx.panels).forEach(([key, panel]) => {
      const config = this.ctx.panelSettings[key];
      if (config) {
        panel.setEnabled(config.enabled);
      }
    });
    this.callbacks.ensureCorrectZones();
  }
}
