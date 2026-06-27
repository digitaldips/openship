/**
 * SSH Connection Manager - per-server cached executors with idle-TTL.
 *
 * All server interactions go through `sshManager.acquire(serverId)` or
 * the convenience wrapper `sshManager.withExecutor(serverId, fn)`.
 *
 * Each serverId gets its own cached connection with an independent idle
 * timer. After idleTimeoutMs with no usage the connection drops silently.
 * Next acquire() reconnects from fresh DB settings.
 *
 * Invalidation:
 *   Call sshManager.invalidate(serverId) when a server's settings change
 *   or it is deleted.  Call sshManager.invalidate() (no arg) to drop all
 *   connections.
 *
 * Retry on error:
 *   withExecutor(serverId, fn) catches connection-level errors, invalidates,
 *   and retries fn once with a fresh executor. This handles stale
 *   connections transparently.
 *
 * Security:
 *   - SSH credentials are read from DB on each connect(), never cached
 *     in memory beyond the ssh2 client's internal state.
 *   - Idle timeout ensures connections don't linger when unused.
 *   - Timers use unref() so they don't prevent graceful shutdown.
 */

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { repos } from "@repo/db";
import {
  createExecutor,
  isRetryableRemoteConnectionError,
  type CommandExecutor,
  type SshConfig,
} from "@repo/adapters";
import { formatDuration, systemDebug } from "@/lib/system-debug";
import { decryptSecretField } from "@/lib/credential-encryption";
import { resolveSafeSshKeyPath } from "@/lib/ssh-key-path";
import { safeErrorMessage } from "@repo/core";

// ─── Shared SSH config builder ───────────────────────────────────────────────

/** Settings shape accepted by `buildSshConfig`. */
export interface SshSettingsInput {
  sshHost: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  sshAuthMethod?: string | null;
  sshPassword?: string | null;
  sshKeyPath?: string | null;
  sshKeyPassphrase?: string | null;
}

/**
 * Map a settings object → `SshConfig`.  Works for both DB rows and
 * plain request-body objects.  Returns `null` when the input is
 * incomplete or invalid (e.g. missing host, unreadable key file,
 * path-traversal attempt).
 */
export async function buildSshConfig(
  settings: SshSettingsInput,
): Promise<SshConfig | null> {
  if (!settings.sshHost) return null;

  const config: SshConfig = {
    host: settings.sshHost,
    port: settings.sshPort ?? 22,
    username: settings.sshUser ?? "root",
  };

  if (settings.sshAuthMethod === "password" && settings.sshPassword) {
    // Stored encrypted on insert; decrypted only here at the moment we
    // hand it to the ssh2 client.
    config.password = decryptSecretField(settings.sshPassword);
  } else if (settings.sshAuthMethod === "key" && settings.sshKeyPath) {
    // Centralised allowlist + traversal check — see lib/ssh-key-path.ts.
    // homedir() is the operator's home, used as the default convenient
    // root so `~/.ssh/openship` works without explicit env config.
    let keyPath: string;
    try {
      keyPath = resolveSafeSshKeyPath(settings.sshKeyPath, {
        extraRoots: [homedir()],
      });
    } catch {
      return null;
    }

    try {
      config.privateKey = readFileSync(keyPath, "utf-8");
    } catch {
      return null;
    }
    if (settings.sshKeyPassphrase) {
      config.privateKeyPassphrase = decryptSecretField(settings.sshKeyPassphrase);
    }
  } else if (settings.sshAuthMethod === "agent") {
    // Use the host's SSH agent (SSH_AUTH_SOCK) — like VSCode Remote-SSH. No
    // password or key is stored; the agent must already hold a key the
    // server accepts (e.g. the operator ran `ssh-copy-id` / `ssh` to it
    // before). Self-hosted only — this is the API host's own agent. The
    // `sshAgent` field flows through toConnectConfig → ssh2's `agent` option.
    const sock = process.env.SSH_AUTH_SOCK;
    if (!sock) {
      throw new Error(
        "SSH agent auth is selected, but no agent is available on this host " +
          "(SSH_AUTH_SOCK is unset). Start an ssh-agent and add the key, or " +
          "switch this server to password/key auth.",
      );
    }
    config.sshAgent = sock;
  } else {
    return null;
  }

  return config;
}

function debugSsh(message: string): void {
  systemDebug("ssh-manager", message);
}

// ─── Options ─────────────────────────────────────────────────────────────────

interface SshManagerOptions {
  /** Idle timeout before dropping a cached connection (default: 5 min) */
  idleTimeoutMs?: number;
}

const DEFAULTS = {
  idleTimeoutMs: 5 * 60_000,
} as const;

// Circuit-breaker. After this many consecutive connect/command failures, a
// server is marked unhealthy and acquire() FAST-FAILS for COOLDOWN_MS instead
// of re-attempting — which otherwise re-eats a multi-second timeout on every
// poll tick (e.g. the 3s live-metrics SSE hammering an unreachable box with
// 5s command timeouts). One success resets it.
const FAIL_THRESHOLD = 2;
const COOLDOWN_MS = 30_000;

// ─── Per-server connection state ─────────────────────────────────────────────

interface ServerConnection {
  executor: CommandExecutor;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class SshConnectionManager {
  private servers = new Map<string, ServerConnection>();
  private connecting = new Map<string, Promise<CommandExecutor>>();
  private retainCounts = new Map<string, number>();
  /** Circuit-breaker state per server (consecutive fails + cooldown deadline). */
  private health = new Map<string, { fails: number; unhealthyUntil: number }>();
  private destroyed = false;
  private readonly opts: Required<SshManagerOptions>;

  constructor(options?: SshManagerOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Get a cached executor for the given server, creating one if needed.
   * Resets the idle timer on every call.
   *
   * Throws if the server doesn't exist or auth is invalid.
   */
  async acquire(serverId: string): Promise<CommandExecutor> {
    const startedAt = Date.now();
    if (this.destroyed) throw new Error("SshManager has been destroyed");

    const cached = this.servers.get(serverId);
    if (cached) {
      this.touchIdleTimer(serverId);
      debugSsh(`acquire:reuse server=${serverId} (${formatDuration(startedAt)})`);
      return cached.executor;
    }

    // Circuit-breaker: a server that just failed repeatedly is in cooldown —
    // fast-fail instead of attempting (and waiting out) another timeout.
    const cooldownLeft = this.cooldownRemaining(serverId);
    if (cooldownLeft > 0) {
      debugSsh(`acquire:short-circuit server=${serverId} cooldown=${cooldownLeft}ms`);
      throw new Error(
        `Server is unreachable — cooling down after repeated failures, retry in ~${Math.ceil(cooldownLeft / 1000)}s.`,
      );
    }

    // Dedup concurrent acquire() calls for the same server
    const pending = this.connecting.get(serverId);
    if (pending) {
      debugSsh(`acquire:join-existing-connect server=${serverId}`);
      return pending;
    }

    debugSsh(`acquire:connect-start server=${serverId}`);
    const promise = this.connect(serverId);
    this.connecting.set(serverId, promise);
    try {
      const exec = await promise;
      this.servers.set(serverId, { executor: exec, idleTimer: null });
      this.touchIdleTimer(serverId);
      this.recordSuccess(serverId);
      debugSsh(`acquire:executor-ready server=${serverId} (${formatDuration(startedAt)})`);
      return exec;
    } catch (err) {
      const msg = safeErrorMessage(err);
      this.recordFailure(serverId);
      debugSsh(`acquire:failed server=${serverId} (${formatDuration(startedAt)}) ${msg}`);
      throw err;
    } finally {
      this.connecting.delete(serverId);
    }
  }

  /**
   * Run an operation with automatic retry on connection errors.
   *
   * If `fn` fails with a connection-level error (reset, timeout, etc.),
   * the executor is invalidated and `fn` is retried once with a fresh
   * connection. Non-connection errors propagate immediately.
   */
  async withExecutor<T>(
    serverId: string,
    fn: (executor: CommandExecutor) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const executor = await this.acquire(serverId);
    try {
      const result = await fn(executor);
      this.recordSuccess(serverId);
      debugSsh(`withExecutor:done server=${serverId} (${formatDuration(startedAt)})`);
      return result;
    } catch (err) {
      if (isRetryableRemoteConnectionError(err)) {
        const msg = safeErrorMessage(err);
        debugSsh(`withExecutor:retry-after-connection-error server=${serverId} ${msg}`);
        this.dropServer(serverId);
        const freshExecutor = await this.acquire(serverId);
        const result = await fn(freshExecutor);
        this.recordSuccess(serverId);
        debugSsh(`withExecutor:retry-done server=${serverId} (${formatDuration(startedAt)})`);
        return result;
      }
      const msg = safeErrorMessage(err);
      // Connection errors and command timeouts count toward the breaker — a
      // sick/unreachable box shouldn't be re-hit every poll tick.
      if (isRetryableRemoteConnectionError(err) || /timed out|timeout|ETIMEDOUT/i.test(msg)) {
        this.recordFailure(serverId);
      }
      debugSsh(`withExecutor:failed server=${serverId} (${formatDuration(startedAt)}) ${msg}`);
      throw err;
    }
  }

  /** Whether there's an active connection for a given server. */
  isConnected(serverId: string): boolean {
    return this.servers.has(serverId);
  }

  /**
   * Drop connection(s) immediately.
   *
   * @param serverId - drop a specific server connection.
   *   Omit to drop all connections.
   */
  invalidate(serverId?: string): void {
    if (serverId) {
      debugSsh(`invalidate server=${serverId}`);
      this.dropServer(serverId);
      // Config changed / explicit reset → give the breaker a fresh start.
      this.health.delete(serverId);
    } else {
      debugSsh("invalidate:all");
      for (const id of [...this.servers.keys()]) {
        this.dropServer(id);
      }
      this.health.clear();
    }
  }

  /**
   * Mark a connection as actively in use by a long-lived operation
   * (streaming, Docker tunnels, etc.).
   *
   * Pauses the idle timer so the connection isn't dropped mid-stream.
   * Must be paired with a `release()` call.
   */
  retain(serverId: string): void {
    const count = (this.retainCounts.get(serverId) ?? 0) + 1;
    this.retainCounts.set(serverId, count);
    // Pause idle timer while retained
    const conn = this.servers.get(serverId);
    if (conn?.idleTimer) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = null;
    }
    debugSsh(`retain server=${serverId} count=${count}`);
  }

  /**
   * Release a long-lived hold on a connection.
   * When all holds are released, the idle timer restarts.
   */
  release(serverId: string): void {
    const count = Math.max(0, (this.retainCounts.get(serverId) ?? 0) - 1);
    if (count === 0) {
      this.retainCounts.delete(serverId);
      this.touchIdleTimer(serverId);
    } else {
      this.retainCounts.set(serverId, count);
    }
    debugSsh(`release server=${serverId} count=${count}`);
  }

  /** Shut down the manager. No further acquire() calls allowed. */
  destroy(): void {
    this.destroyed = true;
    debugSsh("destroy");
    this.invalidate();
  }

  // ── Connection lifecycle ───────────────────────────────────────────────

  /** Look up a server by ID and create a fresh executor. */
  private async connect(serverId: string): Promise<CommandExecutor> {
    const startedAt = Date.now();
    debugSsh(`connect:load-settings server=${serverId}`);

    const server = await repos.server.get(serverId);
    if (!server?.sshHost) {
      throw new Error("No server configured");
    }

    const sshConfig = await buildSshConfig(server);
    if (!sshConfig) {
      throw new Error("Invalid SSH auth configuration");
    }

    const executor = createExecutor(sshConfig);
    debugSsh(`connect:executor-prepared server=${serverId} (${formatDuration(startedAt)}) host=${sshConfig.host}`);
    return executor;
  }

  // ── Circuit-breaker ────────────────────────────────────────────────────

  /** Milliseconds remaining in this server's cooldown, or 0 if healthy. */
  private cooldownRemaining(serverId: string): number {
    const h = this.health.get(serverId);
    if (!h) return 0;
    return Math.max(0, h.unhealthyUntil - Date.now());
  }

  /** One success clears the breaker entirely. */
  private recordSuccess(serverId: string): void {
    if (this.health.has(serverId)) this.health.delete(serverId);
  }

  /** Count a connect/command failure; trip the breaker at the threshold and
   *  drop any cached (now-suspect) connection so the cooldown actually bites. */
  private recordFailure(serverId: string): void {
    const h = this.health.get(serverId) ?? { fails: 0, unhealthyUntil: 0 };
    h.fails += 1;
    if (h.fails >= FAIL_THRESHOLD) {
      h.unhealthyUntil = Date.now() + COOLDOWN_MS;
      this.dropServer(serverId);
      debugSsh(`circuit-open server=${serverId} fails=${h.fails} cooldown=${COOLDOWN_MS}ms`);
    }
    this.health.set(serverId, h);
  }

  // ── Idle timer ─────────────────────────────────────────────────────────

  private touchIdleTimer(serverId: string): void {
    const conn = this.servers.get(serverId);
    if (!conn) return;

    // Don't set idle timer while connection is retained by long-lived ops
    if ((this.retainCounts.get(serverId) ?? 0) > 0) return;

    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = setTimeout(() => {
      debugSsh(`idle-timeout:drop-connection server=${serverId}`);
      this.dropServer(serverId);
    }, this.opts.idleTimeoutMs);
    if (conn.idleTimer.unref) conn.idleTimer.unref();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  private dropServer(serverId: string): void {
    const conn = this.servers.get(serverId);
    if (!conn) return;

    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    this.retainCounts.delete(serverId);
    if ("dispose" in conn.executor && typeof conn.executor.dispose === "function") {
      conn.executor.dispose();
    }
    this.servers.delete(serverId);
    debugSsh(`drop-server server=${serverId}`);
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const sshManager = new SshConnectionManager();
