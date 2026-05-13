/**
 * EdgeOS backend installer — placeholder.
 *
 * EdgeOS provides calendar, RSVP, venue, and directory APIs. Runtime guidance
 * lives in `../skills/edgeos/` and is staged into the OpenClaw workspace by
 * the orchestrator. Credential provisioning is still handled externally by
 * EdgeOS / InstaClaw, so this installer does not write secrets or API config
 * yet.
 *
 * Invoked only by the orchestrator (`install.ts`) — not a standalone
 * entrypoint. If your EdgeOS integration needs OpenClaw configuration (MCP
 * server entries, cron jobs, gateway settings), wire it here. Runtime
 * Expected runtime env/config, once wired:
 *
 *   - EDGEOS_BASE_URL (default https://api.edgeos.world)
 *   - EDGEOS_POPUP_ID
 *   - EDGEOS_POPUP_SLUG
 *   - EDGEOS_API_KEY (per-user EdgeOS key, bearer credential)
 */

export function installEdgeos(): void {
  // placeholder — no-op
}
