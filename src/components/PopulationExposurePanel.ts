import { Panel } from "./Panel";
import { escapeHtml } from "@/utils/sanitize";
import type { PopulationExposure } from "@/types";
import { formatPopulation } from "@/services/population-exposure";

export class PopulationExposurePanel extends Panel {
  private exposures: PopulationExposure[] = [];

  constructor() {
    super({
      id: "population-exposure",
      title: "Population Exposure",
      showCount: true,
      trackActivity: true,
      infoTooltip: `<strong>Population Exposure Estimates</strong>
        Estimated population within event impact radius.
        Based on WorldPop country density data.
        <ul>
          <li>Conflict: 50km radius</li>
          <li>Earthquake: 100km radius</li>
          <li>Flood: 100km radius</li>
          <li>Wildfire: 30km radius</li>
        </ul>`,
    });
    this.showLoading("Calculating exposure");
  }

  public setExposures(exposures: PopulationExposure[]): void {
    this.exposures = exposures;
    this.setCount(exposures.length);
    this.renderContent();
  }

  private renderContent(): void {
    if (this.exposures.length === 0) {
      this.setContent(
        '<div class="panel-empty">No exposure data available</div>',
      );
      return;
    }

    const totalAffected = this.exposures.reduce(
      (sum, e) => sum + e.exposedPopulation,
      0,
    );

    const cards = this.exposures
      .slice(0, 30)
      .map((e) => {
        const typeIcon = this.getTypeIcon(e.eventType);
        const popClass =
          e.exposedPopulation >= 1_000_000 ? " popexp-pop-large" : "";
        return `<div class="popexp-card">
        <div class="popexp-card-name">${typeIcon} ${escapeHtml(e.eventName)}</div>
        <div class="popexp-card-meta">
          <span class="popexp-card-pop${popClass}">${formatPopulation(e.exposedPopulation)} affected</span>
          <span class="popexp-card-radius">${e.exposureRadiusKm}km radius</span>
        </div>
      </div>`;
      })
      .join("");

    this.setContent(`
      <div class="popexp-panel-content">
        <div class="popexp-summary">
          <span class="popexp-label">Total Affected</span>
          <span class="popexp-total">${formatPopulation(totalAffected)}</span>
        </div>
        <div class="popexp-list">${cards}</div>
      </div>
      <style>
        .popexp-panel-content { font-size: 12px; }
        .popexp-summary { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; margin-bottom: 6px; background: rgba(239, 68, 68, 0.08); border-radius: 4px; border-left: 3px solid #ef4444; }
        .popexp-label { color: #999; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
        .popexp-total { color: #fff; font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .popexp-list { display: flex; flex-direction: column; }
        .popexp-card { padding: 6px 10px; border-bottom: 1px solid #1a1a1a; }
        .popexp-card:hover { background: #1a1a1a; }
        .popexp-card-name { color: #ddd; font-size: 12px; line-height: 1.4; margin-bottom: 3px; word-break: break-word; }
        .popexp-card-meta { display: flex; justify-content: space-between; align-items: center; }
        .popexp-card-pop { color: #ef4444; font-size: 11px; font-variant-numeric: tabular-nums; font-weight: 500; }
        .popexp-pop-large { color: #fff; font-weight: 700; }
        .popexp-card-radius { color: #666; font-size: 11px; font-variant-numeric: tabular-nums; }
      </style>
    `);
  }

  private getTypeIcon(type: string): string {
    switch (type) {
      case "state-based":
      case "non-state":
      case "one-sided":
      case "conflict":
      case "battle":
        return "\u2694\uFE0F";
      case "earthquake":
        return "\uD83C\uDF0D";
      case "flood":
        return "\uD83C\uDF0A";
      case "fire":
      case "wildfire":
        return "\uD83D\uDD25";
      default:
        return "\uD83D\uDCCD";
    }
  }
}
