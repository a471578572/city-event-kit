import { freshState } from './business.mjs';

// Explicit fixture for compatibility checks only. New real events always use
// phone registration; legacy ticket backups remain readable without migration.
export function legacyFreshState() {
  const state = freshState();
  delete state.event.entryMode;
  delete state.event.teamsOpen;
  return state;
}
