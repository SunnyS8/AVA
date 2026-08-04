// Thin facade over the wizard-env contract. The source of truth for the
// .env shape lives in ./wizard-env-contract.ts and is tested against the
// engine's envSchema by tests/multi/server/wizard-env-smoke.test.ts.
//
// We re-export rather than re-implement so the wizard cannot drift from
// what the engine accepts.
export {
  generateEnv,
  type EnvParams,
  type GeneratedEnv,
} from './wizard-env-contract'
