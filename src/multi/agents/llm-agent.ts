/**
 * Local stand-in for ADK's LlmAgent class.
 *
 * Why this exists: Betsy uses our own `runWithGeminiTools` loop (see
 * gemini-runner.ts) and never touches ADK's SessionService / runner. The only
 * thing we needed from `@google/adk` was the `LlmAgent` class as a typed
 * data container — name, model, instruction, tools. Importing the @google/adk
 * barrel forced us to ship 18 transitive peer dependencies (telemetry
 * exporters, mikro-orm drivers, GCS) on prod node_modules — for zero
 * functional gain.
 *
 * This file gives us the same shape with zero deps. The test stub at
 * tests/__mocks__/google-adk.ts mirrors it.
 */
export class LlmAgent {
  public name?: string
  public model?: string
  public instruction?: string
  public description?: string
  public tools?: unknown[]

  constructor(config: Record<string, unknown> = {}) {
    Object.assign(this, config)
  }
}
