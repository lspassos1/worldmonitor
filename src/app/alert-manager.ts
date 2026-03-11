import { STORAGE_KEYS } from '@/config';
import { loadFromStorage, saveToStorage } from '@/utils';
import { t } from '@/services/i18n';

export interface AlertRule {
  id: string;
  type: 'market' | 'intel';
  symbol: string;
  threshold?: number;
  condition?: 'above' | 'below' | 'change' | 'contains';
  lastTriggered?: number;
  enabled: boolean;
}

export class AlertManager {
  private rules: AlertRule[] = [];

  constructor() {
    this.rules = loadFromStorage<AlertRule[]>(STORAGE_KEYS.alerts, []);
  }

  public getRules(): AlertRule[] {
    return [...this.rules];
  }

  public addRule(rule: Omit<AlertRule, 'id' | 'enabled'>): void {
    const newRule: AlertRule = {
      ...rule,
      id: Math.random().toString(36).substr(2, 9),
      enabled: true,
    };
    this.rules.push(newRule);
    this.save();
  }

  public removeRule(id: string): void {
    this.rules = this.rules.filter(r => r.id !== id);
    this.save();
  }

  public toggleRule(id: string): void {
    const rule = this.rules.find(r => r.id === id);
    if (rule) {
      rule.enabled = !rule.enabled;
      this.save();
    }
  }

  private save(): void {
    saveToStorage(STORAGE_KEYS.alerts, this.rules);
  }

  public checkMarketAlerts(data: Array<{ symbol: string; price: number | null; name: string }>): void {
    const now = Date.now();
    data.forEach(item => {
      if (item.price === null) return;
      const currentPrice = item.price;
      this.rules.filter(r => r.enabled && r.type === 'market' && r.symbol === item.symbol).forEach(rule => {
        // Cooldown: 1 hour between alerts for same rule
        if (rule.lastTriggered && (now - rule.lastTriggered) < 3600000) return;

        let triggered = false;
        if (rule.condition === 'above' && rule.threshold !== undefined && currentPrice >= rule.threshold) triggered = true;
        if (rule.condition === 'below' && rule.threshold !== undefined && currentPrice <= rule.threshold) triggered = true;

        if (triggered) {
          rule.lastTriggered = now;
          this.triggerAlert(`${t('alerts.marketHit')}: ${item.name} is ${rule.condition} ${rule.threshold} (Current: ${currentPrice})`);
          this.save();
        }
      });
    });
  }

  public checkIntelAlerts(data: Array<{ id: string; source: string; headline: string }>): void {
    const now = Date.now();
    data.forEach(item => {
      const text = `${item.source} ${item.headline}`.toLowerCase();
      this.rules.filter(r => r.enabled && r.type === 'intel').forEach(rule => {
        // Cooldown: 10 minutes for intel alerts (since news can be repetitive)
        if (rule.lastTriggered && (now - rule.lastTriggered) < 600000) return;

        const keyword = rule.symbol.toLowerCase(); // Using symbol field for keyword
        if (text.includes(keyword)) {
          rule.lastTriggered = now;
          this.triggerAlert(`${t('alerts.intelHit')}: ${item.source} - ${item.headline}`);
          this.save();
        }
      });
    });
  }

  private triggerAlert(message: string): void {
    console.log(`[AlertManager] TRIGGER: ${message}`);
    
    const event = new CustomEvent('wm:breaking-news', {
      detail: {
        id: `alert-${Date.now()}`,
        source: 'Signal Alert',
        headline: message,
        threatLevel: 'high',
        timestamp: new Date(),
        origin: 'signal_alert'
      }
    });
    document.dispatchEvent(event);
    
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('World Monitor Alert', { body: message });
    }
  }

  public async requestNotificationPermission(): Promise<void> {
    if ('Notification' in window && Notification.permission !== 'granted') {
      await Notification.requestPermission();
    }
  }
}
