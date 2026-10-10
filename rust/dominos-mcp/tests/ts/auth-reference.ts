// Synthetic seed/inspection helpers keep tokens out of the binary's public surface.
export {
  loadSession,
  saveSession,
  SESSION_MAX_BYTES,
  withSession,
  type Session,
} from '../../../../packages/dominos-mcp/src/auth.ts';
export { login, logout, migrate, requestCode, sessionStorage } from './rust-dominos.ts';
export { phoneNumber } from '../../../../packages/dominos-mcp/src/auth.ts';
