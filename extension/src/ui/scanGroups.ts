// Page targets (PageContext.targets) -> scan groups, one per zone, in a fixed zone order.
// Choosing a target never clicks the shop page directly: it is handed to `onSelect`, which sends
// it through the normal turn so consequential actions still get a confirmation.
import type { ActionTarget, Zone } from '@shared/index';
import type { ScanGroup } from './scanner';
import { label, type UiKey } from './strings';

export const ZONE_ORDER: readonly Zone[] = [
  'search',
  'results',
  'product',
  'cart',
  'checkout',
  'orders',
  'help',
];

export function groupsFromTargets(
  targets: ActionTarget[],
  onSelect: (target: ActionTarget) => void,
  lang?: string,
): ScanGroup[] {
  return ZONE_ORDER.map((zone) => ({
    id: zone,
    label: label(`zone.${zone}` as UiKey, lang),
    items: targets
      .filter((t) => t.zone === zone && !t.state?.disabled)
      .map((t) => ({ id: t.id, label: t.label, activate: () => onSelect(t) })),
  })).filter((g) => g.items.length > 0);
}
