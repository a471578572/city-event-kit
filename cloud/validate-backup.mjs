#!/usr/bin/env node
// Read-only validation. Never connects to a database or prints private records.
import { readFile } from 'node:fs/promises';
import { validateRestore } from './business.mjs';

if (process.argv.length !== 3) {
  console.error('Usage: node validate-backup.mjs /absolute/path/to/private-backup.json');
  process.exitCode = 2;
} else {
  try {
    const document = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const state = validateRestore(document);
    console.log(JSON.stringify({ valid: true, schemaVersion: document.schemaVersion, phase: state.event.phase,
      teams: state.teams.length, judges: state.judges.length, people: state.voters.length,
      scores: state.scores.length, ballots: state.ballots.length }));
  } catch {
    // Paths, input fields, phone numbers, tokens, and error payloads stay private.
    console.error('BACKUP_VALIDATION_FAILED');
    process.exitCode = 1;
  }
}
