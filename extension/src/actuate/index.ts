// Performs ClientActions in the user's tab (Track B). STUB: performs nothing.
import type { ClientAction } from '@shared/index';

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

export async function performAction(_action: ClientAction): Promise<ActionResult> {
  return { ok: false, reason: 'not implemented' };
}
